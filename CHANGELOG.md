# Changelog

## [0.1.0] - 2026-11-09

- First packaged release of `deepinfra-imagegen`.
- Tool `generate_image`: any DeepInfra `image-gen` model, per-model input schema
  resolution, reference images (`refs`), `size`/`aspect_ratio`, `seed`, `count`,
  `transparent` (Bria RMBG alpha), and inline `preview`.
- Prompt sidecar at `<out>.json` preserving an existing `"approved": true`
  (what Impeccable's `build-phase advance` reads).
- Command `/deepinfra-image [list | <model> | refresh]`.
- Key resolution: pi's credential store for the `deepinfra` provider, then
  `DEEPINFRA_API_KEY`, then `~/.pi/agent/auth.json`.
