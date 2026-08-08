# Norvyn interface design

Norvyn uses a warm, near-black local-workbench palette with a high-energy green accent. The canonical values
live as semantic CSS custom properties in `src/client/styles.css`; components consume those properties instead
of repeating shared literals.

## Palette

| Token role           | Value     | Use                                    |
| -------------------- | --------- | -------------------------------------- |
| Canvas               | `#10140f` | Main background                        |
| Recessed canvas      | `#0d100d` | Deep panels and inputs                 |
| Surface              | `#151a14` | Cards and elevated panels              |
| Raised surface       | `#1b2119` | Hovered or selected surfaces           |
| Border               | `#465140` | Normal structural borders              |
| Muted border         | `#2b3128` | Quiet separators                       |
| Primary text         | `#f0f2eb` | Headings and important copy            |
| Secondary text       | `#bdc5b7` | Supporting copy                        |
| Muted text           | `#899383` | Metadata and placeholders              |
| Accent / connected   | `#c5ff62` | Primary action, focus, connected state |
| Warning / connecting | `#d3b94b` | Waiting or degraded state              |
| Error / disconnected | `#ff7667` | Failure and destructive action         |

Supporting semantic roles are `--accent-text` (`#d2ff83`), `--danger-text` (`#ffd8d3`), `--warning-text`
(`#d9b96e`), `--secondary-muted` (`#aab3a4`), `--label-muted` (`#657060`), `--timestamp` (`#60695d`),
`--code-muted` (`#c5cabf`), `--detail-border` (`#2c332a`), `--section-border` (`#242a22`), `--inset-surface`
(`#111510`), `--inset-deep` (`#0c0f0c`), `--dropdown-surface` (`#181d17`), `--transcript-scrollbar`
(`#4e5949`), and `--composer-scrollbar` (`#596451`). Dialog backdrops use `--backdrop` (`#070907d9`).

## Spacing, shape, and layers

The spacing scale is `--space-1` (4px), `--space-2` (8px), `--space-3` (12px), `--space-4` (18px), and
`--space-5` (24px). Shared shapes use `--radius-small`, `--radius-control`, `--radius-medium`,
`--radius-panel`, `--radius-composer`, and `--radius-round`; new components should not invent a near-duplicate
radius.

Stacking is semantic rather than component-specific: `--layer-content`, `--layer-toolbar`, `--layer-tooltip`,
`--layer-menu`, `--layer-actions`, `--layer-dialog`, `--layer-banner`, and `--layer-modal`. A feature should
use the lowest layer that expresses its interaction role.

Green is the product accent and also means healthy/connected. Amber is reserved for transitional or warning
states. Coral is reserved for failures and destructive actions. Do not use a status color decoratively.

## Overlays and gradients

Opacity variants are encoded as tokens such as `--accent-overlay-subtle`, `--accent-overlay`,
`--danger-overlay`, and `--white-overlay`. The application canvas combines a subtle diagonal hairline with a
radial green glow through `--app-background`; dialogs use the same surfaces without inventing new gradients.

The stylesheet also contains a small tonal ramp for local shadows, tool states, and controls. A raw color
literal may remain only inside `:root`, where it defines a token, or for a one-off syntax-highlight color
whose role is self-evidently local.

## Typography, density, and focus

Text scale is controlled by `data-text-scale` (`small`, `medium`, `large`), and transcript spacing by
`data-transcript-density` (`comfortable`, `compact`). Interactive controls require a visible accent focus
ring; color alone must never be the only state indicator.
