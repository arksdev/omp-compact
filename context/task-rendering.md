## Task presentation route

**Status:** active · **Evidence:** confirmed

`task` should use the compact renderer rather than the native-live renderer. The native task card is disproportionately large for the intended transcript presentation; users need a bounded one-line `task: ...` row like other routine tools. Keep genuinely interactive surfaces (`ask`, `browser`, `computer`, `resolve`, `reject`) native because their UI is part of the interaction contract.

**Rejected:** keeping `task` in `native-live` would preserve the oversized card and contradict the requested compact transcript behavior. Broadly changing every native-live tool would risk breaking prompts, browser/computer controls, and other interactive surfaces.
