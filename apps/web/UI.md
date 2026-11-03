# Dashboard UI contract

Applies to customer and operator pages under `src`. Payload admin keeps its
host theme. Quickstart HTML is a separate renderer; it must adopt this contract
when that renderer is changed. Do not copy its CSS into dashboard features.

## Actions and navigation

- One primary action per view or independently actionable card: `Button` default,
  cobalt `#263fa9`, white text in both themes. Examples: New sandbox, Build/Rebuild,
  Create, Save. Do not make every action blue.
- Secondary: `outline` (visible neutral control border) or `secondary` (tinted).
  Examples: Disable, Cancel, filters, optional validation.
- Tertiary: `ghost`. Navigation: `NavItem` with icons, left aligned, active page
  uses `aria-current="page"`. Footer and drawer use the same component.
- Destructive: `destructive`, with `ConfirmButton`/`FormDialog` confirmation.
  Delete sandbox still requires the slug. Never remove an existing confirmation.
- Navigation uses `Link`/`a`; mutations use buttons. A link that looks like an
  action is composed as `Button asChild`. Inline links are underlined and use
  `text-link`, which has a readable dark-theme token. No button-shaped ad hoc links.
- Controls: default 40px (48px from 768px); compact `sm` 40px, `xs` 28px only
  for dense auxiliary controls. Icons 18px, icon-only controls have an accessible
  label and a tooltip/title. Use existing Lucide icons.

## Composition

- `AppShell` owns sidebar offset, responsive padding and the 72rem maximum width.
  The work area starts next to the sidebar padding, left aligned. Features must
  not add another centering container or override the shell width.
- `PageHeader`: title, optional metadata and primary action. `ActionBar` wraps
  auxiliary controls with wrapping and a consistent gap. Detail headings may be
  compact, but should keep the same alignment.
- `Panel`: square, token border/background, 20px padding. Use sections/headings
  for content structure. Do not style descendants through page-specific selectors.
- `EmptyState`: icon, explanation and a next step. Filtered empty states explain
  the filter result. Onboarding links are visibly underlined: install guide,
  New sandbox form, agent guide. Avoid duplicate competing primary actions.
- Tables use `Table` and its header/cell primitives. Lists use semantic ul/ol;
  responsive sandbox cards retain state, health and activity. Tabs use `Tabs`;
  PTY tabs preserve their button/tab semantics and selection state.
- Badge is information, not an action. Ready/success uses `success`, building or
  degraded uses `warning`, failed uses `destructive`, stopped/unknown uses neutral
  `outline`/`secondary`. Always include a text label; colour alone is insufficient.

## Forms and feedback

- Text/file inputs: `Input`; multiline: `Textarea`; boolean: `Checkbox`; exclusive
  choices: `Radio`. Use `Select` for the existing Radix selector flows; use
  `NativeSelect` when native form submission or compact toolbar selection is
  useful. Both share tokens, square corners, focus, disabled and invalid styles.
- `Field` provides a label, help/error text, required mark and associates its
  controls with error/help via `aria-describedby`, including nested wrappers and Radix triggers. Composite controls keep
  their explicit accessible names. Labels must identify their control; do not
  rely on placeholders. Required validation uses native `required` as appropriate.
- Set `aria-invalid` on invalid fields; errors appear beside the field and use
  destructive text. Retain values after submission failures. Disabled controls
  stay recognisable, cannot activate and are exempt from contrast requirements.
- Dialogs use Radix `Dialog`/`FormDialog`, title, description where useful, focus
  trapping/restoration, Escape and visible close/cancel. Busy mutations cannot be
  submitted twice. Dropdowns/tooltips retain Radix keyboard interactions.
- `QueryError` explains the failure and exposes retry; 401/403 use `AccessPage`
  with branded markup and pre-paint theme restoration. Loading uses a polite
  status; do not invent blank cards that look actionable.
- Code uses `pre`/`code` and the shared `CopyLine`/`CopyButton`; copy feedback goes
  through Sonner. Never reveal secrets through logs, screenshots or notifications.
  Sonner observes root theme class changes, including after toggling appearance.

## Tokens, geometry and accessibility

Inter body, existing display-heading font, existing Umiak logo. Zero corner
radius (except status dots and native radio indicators); no shadows. Spacing uses the 4px scale: 4/8/12/16/20/
24/32/48. Use shared typography classes and existing root scale, no feature-local
font families. All colours belong in `globals.css`, including terminal colours.
The terminal intentionally uses a stable dark canvas in either dashboard theme.

Light and dark must retain action hierarchy, focus outlines, legible secondary
borders and semantic status hues. Text targets WCAG AA 4.5:1 (large text 3:1);
control boundaries and focus indicators target 3:1. Primary white-on-cobalt is
identical in both modes. Never use cobalt for small text on the dark background;
use the link token. Hover/active and keyboard focus must remain visible. Test both
themes and mobile before landing changes; never override `[data-slot="button"]`
from feature CSS to change its hierarchy.

## Checks

`pnpm --filter @umiak/web exec vitest run test/ui-policy.test.ts` scans all TSX,
including UI files for hex colours, and forbids raw controls, action-styled links
and non-brand radius classes outside `components/ui`. It is part of `pnpm test`.
Browser coverage records both themes and checks hierarchy, geometry, theme sync,
focus and palette contrast. Screenshots go to test output or `UMIAK_VISUAL_DIR`;
no customer data or live stand is needed. Source checks are deliberately lexical,
fast and dependency-free; browser checks cover the rendered result.
