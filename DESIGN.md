---
name: AgentConstella
description: A calm desktop workspace for repository tasks, agent workflows, and review.
colors:
  canvas: "#f3f5f8"
  surface: "#ffffff"
  surface-subtle: "#f7f8fa"
  surface-hover: "#edf1f7"
  ink: "#182638"
  text-secondary: "#43536a"
  muted: "#627187"
  line: "#dce2eb"
  line-strong: "#b8c3d2"
  accent: "#2c54cf"
  accent-hover: "#2344ae"
  accent-soft: "#eaf0ff"
  accent-line: "#b1c2f3"
  on-accent: "#ffffff"
  success: "#216b4a"
  success-soft: "#edf7f1"
  success-line: "#a5cbb7"
  warning: "#80520e"
  warning-soft: "#fff6e5"
  warning-line: "#dec28d"
  danger: "#b02b3a"
  danger-soft: "#fff0f1"
  danger-line: "#e4b1b7"
  rail: "#172131"
  rail-surface: "#222f43"
  rail-hover: "#293a52"
  rail-ink: "#f1f5fc"
  rail-muted: "#b3c0d3"
  rail-line: "#344257"
typography:
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "28px"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.035em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  conversation:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.4
  metadata:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  compact: "4px"
  control: "6px"
  inset: "8px"
  panel: "12px"
spacing:
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "20": "20px"
  "24": "24px"
  "32": "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.ink}"
  button-danger-subtle:
    textColor: "{colors.danger}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "8px 12px 8px 0"
  button-danger-subtle-hover:
    backgroundColor: "{colors.danger-soft}"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  nav-active:
    backgroundColor: "{colors.rail-hover}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  scope-chip:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.muted}"
    typography: "{typography.metadata}"
    rounded: "{rounded.compact}"
    padding: "4px 6px"
  task-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "16px"
  project-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "24px"
  workflow-node-ready:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "14px"
    width: "218px"
---

# Design System: AgentConstella

## Overview

**Creative North Star: "Release ledger"**

AgentConstella uses cool working surfaces, an ink navigation rail, and cobalt actions. Quiet rules and readable states organize repository records, conversations, and code for sustained desktop work.

The platform UI sans is intentional for this operational interface. Modest corners and inline vector icons support a precise, restrained character. No raster artwork ships.

**Key Characteristics:**

- Cool near-white canvas with a persistent dark rail.
- Compact UI type; mono for technical evidence.
- Flat work surfaces; elevation for floating UI.
- Labeled states and visible keyboard focus.

The source of truth is `src/renderer/src/design-tokens.css`, followed by the CSS import order in `main.tsx`. Rendered Electron fixtures cover CSS (1440 × 800) and (1000 × 740). Sampled contrast and overflow checks do not constitute full accessibility certification.

## Colors

The frontmatter preserves source hex values. The palette has one action family; semantic colors communicate workflow meaning.

### Primary

- **Action Cobalt** (`accent`, `accent-hover`): actions, active tabs, graph handles, and focus. Hover uses the deeper tone; `on-accent` carries solid-action text.
- **Cobalt Wash / Rule** (`accent-soft`, `accent-line`): ready and running work, supporting icon fields, and selected boundaries.

### Neutral

- **Cool Canvas** (`canvas`): continuous workspace background.
- **White / Quiet / Hover Surface** (`surface`, `surface-subtle`, `surface-hover`): working panels, inset evidence, and interaction feedback.
- **Workspace Ink / Reading Slate / Muted Slate** (`ink`, `text-secondary`, `muted`): primary text, supporting prose, and metadata.
- **Fine / Control Rule** (`line`, `line-strong`): dividers and stronger interactive boundaries.
- **Rail Ink** (`rail`): navigation foundation. Its surface, hover, ink, muted, and line tokens provide the corresponding dark-region treatments.

### Semantic states

- **Accepted Green** (`success` family): completed work and integration evidence. The rail's local-status dot uses a separate lighter green for its dark background.
- **Attention Amber** (`warning` family): acceptance, review, interruption, and required attention.
- **Failure Red** (`danger` family): failures, invalid connections, blocked evidence, and destructive affordances.

**The Text Carries State Rule.** Pair semantic color with an explicit state label. Agent completion, acceptance, human review, and integration remain distinguishable.

## Typography

Use the recorded platform sans for headings and interface prose. There is no separate display face.

- **Headline:** compact page headings; narrow desktop treatments use (24–25px). Graph headings use (24px).
- **Title:** dialog headings. Card and section titles use smaller sizes (14–18px) according to density.
- **Body:** default UI prose, with local reading line-heights (1.6–1.9).
- **Conversation:** node conversation prose, with maximum measure (75ch).
- **Label / Metadata:** actions and supporting information. Aligned counts use tabular numerals where implemented.
- **Code:** commands and review evidence; paths commonly use (11px). Read-only Monaco diffs use the light `vs` theme at (12px).

**The Evidence Type Rule.** Use the UI sans for navigation and prose; use mono for paths, commands, identifiers, and recorded code.

## Layout

The supported Electron minimum is (1000 × 700px). The shell fills the viewport; flex and grid children shrink with `min-width: 0`, and work regions own their scrolling. The default rail is (224px), the breadcrumb bar is (56px), and collection-page insets are (32px).

At widths up to (1180px), the rail becomes (196px), common page insets become (24px), action groups wrap, and gaps tighten. The spacing tokens record recurring steps, not a mandatory grid. Smaller optical adjustments remain in component CSS.

Existing compositions include whole-row project records, three open Kanban columns, an auto-filling catalog grid, and a pannable React Flow canvas with a details pane (300px; compact: 280px). These component patterns do not prescribe every future screen's composition.

Dialogs scroll internally and remain within the viewport. Standard/wide forms cap at (540/650px); the node terminal uses the available window with a (12px) margin on each side. Compact paths may ellipsize while adjacent actions retain their width; longer evidence wraps or scrolls. CSS below (760px) is an unverified fallback, not a mobile support commitment.

## Elevation & Depth

**The Flat Workspace Rule.** Separate working regions with tone and fine borders. Reserve elevation shadows for dialogs, floating manager panels, and transient feedback.

The sidecar records exact overlay and panel shadows from the token file. Dialogs use a translucent rail-tinted backdrop. Cards, ledger rows, conversation panels, and graph nodes have no resting shadow.

Feedback is brief: controls transition over (160ms), project rows over (180ms), and progress transforms over (200ms), using the source ease-out curve where applied. Standard pressed buttons move down (1px). Reduced-motion preference disables animations and transitions globally.

## Shapes

Control corners are modest; panel corners unify cards, graph nodes, and dialogs. Insets use softer small corners; metadata uses compact corners. Existing small controls retain local radii (3–7px). Circles serve dots and graph handles.

Fine one-pixel rules define regions. Dashed boundaries identify drop targets, empty zones, and interrupted graph state. Inline Lucide SVGs inherit the current text color.

## Components

### Buttons

Standard actions have minimum height (36px), icon gap (8px), and the shared label role. Primary hover deepens cobalt. Secondary buttons use a white surface and control rule; hover adds the hover surface and darker text. Subtle destructive actions use red text and pale red hover fill. Disabled buttons use opacity (0.5) and a not-allowed cursor.

### Inputs / Fields

White fields use the stronger control rule, readable placeholders, cobalt caret, and control corners. Focus changes form-field borders to cobalt. Keyboard focus uses an outline (2px), offset (3px); compound search and revision fields outline their whole container, offset (2px). Errors use labeled pale red notices.

### Navigation

The rail locally remaps neutral variables to its dark palette. Hover and active links use a lighter rail surface; active labels gain weight (600). Keyboard focus is rail-white. Main navigation rows are at least (40px) high. Icons accompany labels.

### Chips / Tabs

Scope chips and profile tags are quiet metadata. Selected scope and manager tabs use cobalt text on a light surface or wash. Content tabs add a cobalt bottom rule (2px), preserving a second selection cue.

### Cards / Containers

Task and catalog cards use white surfaces, fine rules, and panel corners. Task hover strengthens the border; dragging lowers opacity (0.4). Kanban drop targets use cobalt wash and dashed outlines; empty columns use quiet dashed containers. Loading Projects show stable neutral row skeletons; empty Projects offer create/open actions.

### Ledger rows / Workflow nodes

Project rows are whole navigation targets. Hover or focus changes their tone and opening affordance without shifting layout. Names wrap; compact paths ellipsize.

Graph nodes retain familiar handles and explicit type/state labels. Pending is neutral; ready/running cobalt; completed green; failure red; review/interrupted states amber. Stale, stopped, and interrupted states also have dashed borders. Selection adds a cobalt outline (2px), offset (3px), independent of state. Workflow state CSS loads after graph CSS and controls final node treatments.

### Dialogs / Conversations / Review

Shared native dialogs use white headers, quiet dividers, internal scrolling, and a visible close control. Closing restores prior focus; busy dialogs disable dismissal.

User messages occupy quiet rounded insets; agent prose remains open. Tool output is expandable and scrolls within its region. Failed node attempts expose the actual problem and recovery hint near status; generic Execution details collapses, while the full error remains in the transcript. Footer paths shrink while IDE and Copy path controls preserve their widths. The revision composer keeps a continuous cobalt focus outline.

Agent nodes prioritize the terminal with a compact title and control row. Open in IDE stays visible beside the execution controls. File/diff, activity, tests, and snapshot tabs and the path footer are absent; revision input appears on request. Code inspection opens the agent worktree in the configured IDE. Workflow reviews retain their check summaries and explicit acceptance controls.

## Do's and Don'ts

### Do:

- **Do** reuse canonical CSS variables and shared control treatments.
- **Do** keep state labels, problem summaries, and recovery actions readable beside semantic colors.
- **Do** preserve action widths when truncating paths; wrap or scroll evidence in its own region.
- **Do** keep keyboard focus visible on compound inputs and the revision composer.
- **Do** verify the supported desktop width with long titles, paths, and failure content.

### Don't:

- **Don't** use action or semantic tints as unrelated decorative fills.
- **Don't** spread overlay shadows to ordinary cards, rows, or graph nodes.
- **Don't** replace evidence with decorative imagery or icon-only state meaning.
- **Don't** treat sub-desktop CSS fallbacks as a verified mobile product.
