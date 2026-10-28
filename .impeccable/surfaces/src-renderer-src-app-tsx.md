---
version: 1
slug: "src-renderer-src-app-tsx"
primary_target: "src/renderer/src/App.tsx"
related_targets: ["src/renderer/src/Projects.tsx","src/renderer/src/TaskGraph.tsx","src/renderer/src/NodeWorkspace.tsx","src/renderer/src/ManagerChat.tsx","src/renderer/src/TaskReview.tsx","src/renderer/src/Catalogs.tsx"]
---

# Workspace redesign

Mode: Operate. Scope: the shared Electron app shell, Projects, Kanban board, workflow graph, catalogs, conversations, and review surfaces. The owner delegated visual direction selection and confirmed direct code implementation. Preserve all functionality, data, terminology, and workflow semantics.

## Direction contract

THESIS: A release ledger makes repository work legible from project to accepted integration. Replace the purple dashboard with a light working ledger, a dark navigation rail, and precise rows and task states.

OWN-WORLD: Cool near-white work surfaces, deep blue-black navigation, cobalt actions, dark ink typography, quiet rules, 6px controls, and 12px overlays. Use the platform UI sans; mono is reserved for paths, code, identifiers, and measurements.

STORY: Find a repository, see its workload, open its board, trace a workflow, and review evidence before integration. Status always has a text label alongside color.

FIRST VIEWPORT: A 224px ink rail anchors a 56px breadcrumb bar. Projects starts with a compact heading and Create project action, a single plain-language activity line, then a ruled repository ledger with name, path/brief, task progress, and an open affordance. The signature interaction is a row's focus/hover revealing its cobalt opening affordance without shifting the content. Board and graph inherit the same controls, surfaces, and states.

FORM: Release ledger, grounded candidate 4 of 7; seed key 6dec9505. The individual developer uses a laptop or external monitor in normal room light; the light work surface supports reading code, labels, and reviews while the ink rail anchors navigation. Restrained color strategy.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Direction derivation

1. Code-review workbench: familiar source panes and file hierarchy, strong code inspection.
2. Instrument bench: pale calibrated fields and clear measured state, strong diagnostics.
3. Build control room: dark monitoring fields and teal readiness, strong long-running status.
4. Release ledger: ruled repository records and a persistent ink index, strong task-to-integration traceability.
5. Project archive: indexed folders and tabbed records, strong catalog navigation.
6. Workshop job tickets: task ownership, work stages, and review stamps, strong board organization.
7. Transit network schematic: fixed nodes and explicit connections, strong workflow topology.

## Challenger decisions

- Split-flap concourse: competitive on status scanning, weaker on developer identification. Keep stable column alignment and immediately legible state changes; omit literal flaps.
- Design annual: declined on both audience identification and task clarity. Raise typographic and spacing discipline without printed registration decoration.
- Boarding-pass board: declined on developer identification and task clarity. Raise identity-preserving state feedback; no literal travel motifs.
- Convention catalog: declined on both axes. Raise compact indexing and whole-item navigation without thumbnail artwork.
- Orienteering map: competitive on dependency navigation, weaker on repository clarity. Keep a consistent semantic state legend across graph and board.
- Zoo guide: declined on both axes. Raise region differentiation while keeping standard desktop geometry and controls.

## Verification

Capture the real Electron renderer against isolated fixtures at 1440px and the supported 1000px minimum desktop width. Include Projects, board, graph, conversation, file diff, catalogs, and review. The user's running desktop window cannot be read because computer-use permission is unavailable. No production data is used, and no provider inference is needed for the fixtures.
