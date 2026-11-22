# Cabinet and photo picker appearance release

Verified: November 22, 2026 (America/Chicago).

- Live: https://friends-fridge-jianghui.app.space
- Release: `rel_01M81YR8QQAJC74XN3PQX9BD25`
- Authoritative cloud source: branch `fridge-cabinet-3d`, commit `c3a65e48439da24f684a8b3af6ea46ba80c8a4e3`.
- Business baseline: stable release source `ae551906`. This release changes appearance and upload copy only. Pending data-plane upgrades remain on the migration branch and are not included in this live release.

The cabinet now has a visible right side, top panel, lower seam and recessed interior. The shell, freezer and door share the same mint enamel palette; lighting gradients supply depth. Doors remain closed by default and open or close only when clicked. Reduced-motion preferences remain supported.

The photo picker uses a rounded pale-green area and a Choose photo button. Native file selection, keyboard focus, filenames and disabled states remain intact. Selecting a photo does not invoke paid recognition.

Production build and platform edge/data-plane readiness passed. Local and live browser checks passed at 1280px and 390px: opening/closing the door, clicking the freezer without opening, no horizontal overflow, and choosing a file with its filename displayed. Desktop/mobile screenshots were inspected. These are automated appearance checks, not a full accessibility audit.
