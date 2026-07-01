# Vision Fallback

Pi extension that lets **text-only models** receive images.

When the active model has no vision capability and the user attaches an image,
the extension transparently delegates the image to a **vision-capable secondary
model**, asks it for a contextual description, and injects that description into
the primary model's prompt — stripping the raw image it cannot process.

This is useful for coding with strong text-only models (e.g. `zai/glm-5.2`,
`deepseek/deepseek-v4-pro`) while still being able to paste screenshots,
design mockups, or UI photos.

## How it works

1. User sends a message that contains images.
2. The extension checks whether the **active model** is in `activeModels`
   (the models you declared as needing fallback).
3. If so, it writes each image to a temp file and spawns a headless `pi`
   subprocess using `secondaryModel` with the image attached via `@file`.
4. The subprocess returns a description of the image, focused on what the user
   asked (the user's full text is passed to the secondary model as context).
5. The primary model receives the original user text **plus** the description,
   with the raw image removed.

The secondary model reuses your normal Pi authentication — including OAuth
subscriptions like OpenAI ChatGPT Plus/Pro, Anthropic Max, or GitHub Copilot —
because it is just another `pi` invocation.

## Install

Pick the source that matches how you publish this package:

```bash
# local path (development)
pi install /path/to/vision-fallback

# git
pi install git:github.com/<user>/vision-fallback

# npm
pi install npm:@lucas/vision-fallback
```

Or load it directly without installing:

```bash
pi -e /path/to/vision-fallback
```

## Configure

Add a `visionFallback` block to `~/.pi/agent/settings.json` (global) or
`.pi/settings.json` (project):

```json
{
  "visionFallback": {
    "activeModels": ["zai/glm-5.2", "zai/glm-5.1", "deepseek/deepseek-v4-pro"],
    "secondaryModel": "openai-codex/gpt-5.5",
    "thinking": "high"
  }
}
```

| Field              | Required | Description                                                                 |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `activeModels`     | yes      | List of `provider/id` models that activate the fallback.                    |
| `secondaryModel`   | yes      | Vision-capable model (`provider/id`) used to describe the image.            |
| `thinking`         | no       | Reasoning level for the secondary model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Omit to use the default. |
| `instruction`      | no       | Custom instruction prepended to the secondary model prompt. See below.      |

### Default instruction

The secondary model receives the user's full message text plus the image, with
this instruction:

> Descreva a imagem de forma útil à tarefa do usuário, focando no que for
> relevante. Responda em português.

Override it with `instruction` if you want a different focus or language.

## Model ID format

Model IDs use the `provider/id` form that Pi shows in `/model`, e.g.
`openai-codex/gpt-5.5`, `zai/glm-5.2`, `anthropic/claude-sonnet-4-5`.

The active model is matched against `activeModels` after normalizing, so
`zai/glm-5.2` matches regardless of the thinking level currently selected.

## Notes

- The fallback adds one extra model call (the secondary description) per user
  message that contains images. It only runs when the active model is in
  `activeModels` and the message has images.
- Images are written to a temporary directory under the OS temp dir and removed
  after the description is produced.
- If the secondary model fails, the original message is passed through
  unchanged (images included) so the primary model can still attempt to handle
  it.
