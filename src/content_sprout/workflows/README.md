# Packaged ComfyUI default workflows

Place **API-format** workflow JSON files in this folder. Filenames should match the
stems declared in [`catalog.json`](catalog.json) (for example `text_to_image.json`).

When a file exists:

1. It appears in Settings as a **built-in** workflow.
2. It becomes the **default** for its mapped operation(s) when the user has not
   assigned a different workflow in Settings.
3. Model loaders inside the graph are scanned and listed as **requirements**.
   You can also declare models explicitly under `workflows.<stem>.models` in
   `catalog.json` (merged with scanned models; catalog entries win on the same
   filename).

## Expected files

| File | Operation |
|------|-----------|
| `text_to_image.json` | Text → image |
| `text_to_video.json` | Text → video |
| `image_to_video.json` | Image → video |
| `upscale_image.json` | Upscale image |
| `upscale_video.json` | Upscale video |

Export from ComfyUI with **Save (API Format)** / **Export (API)**. Editor-format
graphs (`nodes` / `links`) are rejected.

## Catalog model entry shape

```json
{
  "filename": "wan2.1_t2v_1.3B_fp16.safetensors",
  "role": "unet",
  "required": true,
  "notes": "Place under ComfyUI/models/diffusion_models/"
}
```
