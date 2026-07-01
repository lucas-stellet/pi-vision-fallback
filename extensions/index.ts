/**
 * Vision Fallback extension for Pi.
 *
 * When the active model is declared in `settings.json` under
 * `visionFallback.activeModels` and the user sends a message with images,
 * this extension delegates the images to a vision-capable secondary model
 * (a headless `pi` subprocess) and injects the resulting description into the
 * primary model's prompt, stripping the raw images the primary model cannot
 * process.
 *
 * Configuration lives in `~/.pi/agent/settings.json` (or `.pi/settings.json`):
 *
 * {
 *   "visionFallback": {
 *     "activeModels": ["zai/glm-5.2"],
 *     "secondaryModel": "openai-codex/gpt-5.5",
 *     "thinking": "high",
 *     "instruction": "Descreva a imagem..."
 *   }
 * }
 *
 * The secondary model is invoked via `pi --mode json -p --no-session`, so it
 * reuses whatever authentication the user has configured for that model —
 * including OAuth subscriptions (OpenAI ChatGPT Plus/Pro, Anthropic Max,
 * GitHub Copilot). Images are attached through `@file`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** Configuration shape read from settings.json. */
interface VisionFallbackConfig {
	/** Models (provider/id) that activate the fallback. */
	activeModels: string[];
	/** Vision-capable model (provider/id) used to describe images. */
	secondaryModel: string;
	/** Optional reasoning level for the secondary model. */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	/** Optional custom instruction prepended to the secondary model prompt. */
	instruction?: string;
}

const DEFAULT_INSTRUCTION =
	"Descreva a imagem de forma útil à tarefa do usuário, focando no que for relevante. Responda em português.";

/** Read and validate the visionFallback block from settings.json. */
function loadConfig(): VisionFallbackConfig | undefined {
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
	let raw: string;
	try {
		raw = fs.readFileSync(settingsPath, "utf8");
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	const block = (parsed as Record<string, unknown>)?.visionFallback;
	if (!block || typeof block !== "object") return undefined;

	const cfg = block as Partial<VisionFallbackConfig>;
	if (!Array.isArray(cfg.activeModels) || cfg.activeModels.length === 0) return undefined;
	if (typeof cfg.secondaryModel !== "string" || !cfg.secondaryModel) return undefined;

	return {
		activeModels: cfg.activeModels.filter((m): m is string => typeof m === "string" && m.length > 0),
		secondaryModel: cfg.secondaryModel,
		thinking: cfg.thinking,
		instruction: cfg.instruction,
	};
}

/** Normalize a model id to `provider/id` for comparison. */
function modelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

/** Write an image's base64 data to a temp file and return its path. */
async function writeImageToTempFile(image: ImageContent, index: number, dir: string): Promise<string> {
	const ext = extensionForMime(image.mimeType);
	const filePath = path.join(dir, `image-${index}${ext}`);
	await fs.promises.writeFile(filePath, Buffer.from(image.data, "base64"));
	return filePath;
}

function extensionForMime(mimeType: string): string {
	switch (mimeType.toLowerCase()) {
		case "image/png":
			return ".png";
		case "image/jpeg":
		case "image/jpg":
			return ".jpg";
		case "image/gif":
			return ".gif";
		case "image/webp":
			return ".webp";
		case "image/bmp":
			return ".bmp";
		default:
			return ".png";
	}
}

/** Build the prompt sent to the secondary model. */
function buildSecondaryPrompt(userText: string, imageCount: number, instruction: string): string {
	const imageWord = imageCount === 1 ? "imagem anexada" : `${imageCount} imagens anexadas`;
	const userPart = userText.trim().length > 0 ? userText.trim() : "(usuário não escreveu texto)";
	return [
		instruction,
		"",
		`O usuário enviou ${imageWord} com a seguinte mensagem:`,
		"---",
		userPart,
		"---",
		"",
		"Descreva a(s) imagem(ns) com foco no que é relevante para a tarefa acima.",
	].join("\n");
}

/** Result of running the secondary model. */
interface SecondaryResult {
	description: string | undefined;
	error?: string;
}

/** Run a headless pi subprocess to describe the images. */
function runSecondaryModel(args: {
	model: string;
	thinking?: string;
	prompt: string;
	imagePaths: string[];
	cwd: string;
	signal?: AbortSignal;
}): Promise<SecondaryResult> {
	return new Promise((resolve) => {
		const cliArgs = ["--mode", "json", "-p", "--no-session", "--model", args.model];
		if (args.thinking) cliArgs.push("--thinking", args.thinking);

		for (const img of args.imagePaths) cliArgs.push(`@${img}`);

		// The prompt is passed as the final positional argument.
		cliArgs.push(args.prompt);

		const { command, args: invocationArgs } = resolvePiInvocation(cliArgs);

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let settled = false;

		const finish = (result: SecondaryResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		try {
			const proc = spawn(command, invocationArgs, {
				cwd: args.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			// The subprocess prints one JSON event per line. We collect the
			// last assistant text message, which is the final description.
			const lastAssistantText = { value: undefined as string | undefined };

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message };
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message && event.message.role === "assistant") {
					for (const part of event.message.content) {
						if (part.type === "text" && part.text.trim().length > 0) {
							lastAssistantText.value = part.text;
						}
					}
				}
			};

			proc.stdout.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString();
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk: Buffer) => {
				stderrBuffer += chunk.toString();
			});

			proc.on("close", (code) => {
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				if (code !== 0 && lastAssistantText.value === undefined) {
					const trimmedErr = stderrBuffer.trim();
					finish({
						description: undefined,
						error: `pi subprocess exited with code ${code}${trimmedErr ? `: ${trimmedErr.slice(0, 500)}` : ""}`,
					});
					return;
				}
				finish({ description: lastAssistantText.value });
			});

			proc.on("error", (err) => {
				finish({ description: undefined, error: `Failed to spawn pi: ${err.message}` });
			});

			if (args.signal) {
				const kill = () => {
					try {
						proc.kill("SIGTERM");
						setTimeout(() => {
							try {
								if (!proc.killed) proc.kill("SIGKILL");
							} catch {
								/* ignore */
							}
						}, 5000);
					} catch {
						/* ignore */
					}
				};
				if (args.signal.aborted) kill();
				else args.signal.addEventListener("abort", kill, { once: true });
			}
		} catch (err) {
			finish({
				description: undefined,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});
}

/**
 * Resolve how to invoke pi. Mirrors the subagent example: when running under a
 * real pi entry script, reuse the same node + script; otherwise fall back to
 * the `pi` binary on PATH.
 */
function resolvePiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export default function (pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx): Promise<InputEventResult | void> => {
		const images = event.images;
		if (!images || images.length === 0) return; // nothing to do

		const config = loadConfig();
		if (!config) return; // not configured

		const currentModel = ctx.model;
		if (!currentModel) return; // can't tell which model is active

		if (!isActiveForFallback(currentModel, config)) return;

		const instruction = config.instruction?.trim() || DEFAULT_INSTRUCTION;
		const prompt = buildSecondaryPrompt(event.text, images.length, instruction);

		const result = await describeImages({
			images,
			prompt,
			config,
			cwd: ctx.cwd,
			signal: ctx.signal,
		});

		if (result.error) {
			ctx.ui.notify(`vision-fallback: secondary model failed — ${result.error}`, "warning");
			return { action: "continue" };
		}

		if (!result.description) {
			ctx.ui.notify("vision-fallback: secondary model returned no description", "warning");
			return { action: "continue" };
		}

		// Inject the description into the primary model's prompt and strip
		// the raw images, which the text-only primary model cannot process.
		const newText = buildInjectedPrompt(event.text, result.description);

		ctx.ui.setStatus("vision-fallback", `described ${images.length} image(s)`);
		return { action: "transform", text: newText, images: [] };
	});

	// Second trigger path: when the model calls `read` on an image file while
	// the active model is text-only, pi returns the raw ImageContent (which the
	// model cannot process) plus a note that the image was omitted. Intercept
	// that result, describe the image via the secondary model, and replace the
	// content with a textual description so the primary model can use it.
	pi.on("tool_result", async (event, ctx): Promise<{ content: (TextContent | ImageContent)[] } | void> => {
		if (event.toolName !== "read") return;

		const config = loadConfig();
		if (!config) return;

		const currentModel = ctx.model;
		if (!currentModel) return;

		// Only intercept when the active model actually lacks vision. If the
		// active model can handle images, leave the raw ImageContent in place.
		if (!isActiveForFallback(currentModel, config)) return;

		const imageContents = event.content.filter(
			(c): c is ImageContent => c.type === "image",
		);
		if (imageContents.length === 0) return; // not an image read

		// Preserve any non-image text parts (e.g. processing hints).
		const textParts = event.content.filter(
			(c): c is TextContent => c.type === "text",
		);
		const readPath = String(event.input?.path ?? event.input?.file_path ?? "(unknown path)");

		const instruction = config.instruction?.trim() || DEFAULT_INSTRUCTION;
		const userContext = ctx.sessionManager.getBranch()
			?.map((e) => (e.type === "message" && e.message?.role === "user" ? extractText(e.message) : undefined))
			.filter((t): t is string => !!t)
			.slice(-1)[0];
		const prompt = buildSecondaryPrompt(userContext ?? readPath, imageContents.length, instruction);

		const result = await describeImages({
			images: imageContents,
			prompt,
			config,
			cwd: ctx.cwd,
			signal: ctx.signal,
		});

		if (result.error) {
			ctx.ui.notify(`vision-fallback: secondary model failed — ${result.error}`, "warning");
			return;
		}

		if (!result.description) {
			ctx.ui.notify("vision-fallback: secondary model returned no description", "warning");
			return;
		}

		const header = `[Descrição da imagem em ${readPath} gerada por modelo de visão]`;
		const descriptionBlock = `${header}\n${result.description}`;

		// Keep leading text hints (e.g. "Read image file [image/png]"), drop the
		// raw image part and the "image omitted" note, append the description.
		const keptText = textParts
			.map((t) => t.text)
			.filter((t) => !t.includes("image will be omitted from this request"))
			.join("\n")
			.trim();

		const newContent: (TextContent | ImageContent)[] = [
			{ type: "text", text: keptText ? `${keptText}\n\n${descriptionBlock}` : descriptionBlock },
		];

		ctx.ui.setStatus("vision-fallback", `described ${imageContents.length} image(s) from read`);
		return { content: newContent };
	});
}

/** Whether the active model is one that should receive fallback descriptions. */
function isActiveForFallback(model: { provider: string; id: string }, config: VisionFallbackConfig): boolean {
	const key = modelKey(model);
	return config.activeModels.some((m) => m.trim() === key);
}

/** Pull text out of a message's content array (handles string or parts). */
function extractText(message: { content?: string | Array<{ type: string; text?: string }> }): string {
	if (!message.content) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n");
}

/** Shared image-description routine used by both trigger paths. */
async function describeImages(args: {
	images: ImageContent[];
	prompt: string;
	config: VisionFallbackConfig;
	cwd: string;
	signal?: AbortSignal;
}): Promise<SecondaryResult> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-vision-fallback-"));
	let imagePaths: string[] = [];
	try {
		imagePaths = await Promise.all(args.images.map((img, idx) => writeImageToTempFile(img, idx, tmpDir)));
		return await runSecondaryModel({
			model: args.config.secondaryModel,
			thinking: args.config.thinking,
			prompt: args.prompt,
			imagePaths,
			cwd: args.cwd,
			signal: args.signal,
		});
	} finally {
		await Promise.all(
			imagePaths.map((p) =>
				fs.promises.unlink(p).catch(() => {
					/* ignore */
				}),
			),
		);
		await fs.promises.rmdir(tmpDir).catch(() => {
			/* ignore */
		});
	}
}

/** Compose the final prompt that the primary (text-only) model receives. */
function buildInjectedPrompt(originalText: string, description: string): string {
	const trimmed = originalText.trim();
	const header = "[Descrição da imagem gerada por modelo de visão]";
	if (trimmed.length === 0) {
		return `${header}\n${description}`;
	}
	return `${header}\n${description}\n\n---\n\nMensagem original do usuário:\n${originalText}`;
}
