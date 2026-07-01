---
name: vision-fallback
description: |
  Automatic image description fallback for text-only models. When the active
  model cannot process images and the user attaches one, the vision-fallback
  extension delegates the image to a vision-capable secondary model and
  injects a contextual description into your prompt. Use when the user
  attaches screenshots, mockups, or UI photos and you are a text-only model,
  or when you need to explain why an image was replaced by a description.
---

# Vision Fallback

When you are running as a **text-only model** (declared in
`visionFallback.activeModels` in settings.json) and the user attaches an image,
the `vision-fallback` extension transparently:

1. Sends the image to a vision-capable **secondary model** (configured in
   `visionFallback.secondaryModel`), along with the user's full message text.
2. Receives a contextual description focused on what the user asked.
3. Replaces the raw image in your prompt with that description, prefixed by
   `[Descrição da imagem gerada por modelo de visão]`.

## What you see

Instead of an image, you receive a block like:

```
[Descrição da imagem gerada por modelo de visão]
<descrição contextual da imagem>

---

Mensagem original do usuário:
<texto do usuário>
```

## How to behave

- Treat the description as your source of visual information. It was produced
  by a vision model and is focused on the user's request.
- If the description is insufficient for the task, say so explicitly and ask
  the user to clarify or provide more detail, rather than guessing.
- Do not claim you "saw" the image. You are working from a description.
- If the user references "a imagem" / "o print" / "a tela", that refers to the
  described image.

## When this does not apply

- If you are a vision-capable model (not in `activeModels`), you receive the
  raw image as usual and this skill does not activate.
- If the secondary model fails, the original message (with images) is passed
  through unchanged. You may then explain that you cannot process images.
