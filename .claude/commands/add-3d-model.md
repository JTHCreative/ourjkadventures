---
description: Add a new pin GLB to the "See in 3D" viewer
argument-hint: <slug> <path-to-glb>
---
Add the 3D model for the pin `$ARGUMENTS`.

No GLB, only the pin's SVG? Make one with `python3 scripts/svg-to-pin.py <art.svg> <slug> <out.glb>` (red fills and
red outlines become raised gold, every other colour an enamel layer; see the script's top comment), then slim it with
the two gltf-transform steps in `docs/decisions.md`.

1. Check the slug is one of the product slugs in CLAUDE.md.
2. Copy the GLB to the models folder as `<slug>.glb` (today `site/assets/3d/`). Warn if it's over 10 MB, and offer to compress it (e.g. `npx @gltf-transform/cli optimize`) without changing how it looks.
3. Add the slug to the list of pups that have models (`MODEL_3D` in `app.js`, or its replacement after the Astro port). When replacing a model, bump `?v=` there instead, since `/assets/3d/` is cached as never changing.
4. Check: open the pup board, select that pup, "See in 3D" is enabled and the model loads. Another pup without a model stays disabled.
5. Update the "still missing" list in CLAUDE.md and commit with a message like `add 3D model: <slug>`.
