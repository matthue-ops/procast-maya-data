# Repository instructions

These rules apply to all work in this repository.

1. **Obtain approval before implementation.** Before changing application code, behavior, dependencies, configuration, or database structures, explain the proposed changes and obtain explicit user approval. Inspection and read-only investigation may proceed without approval. Approval applies only to the described scope; obtain new approval before expanding it.

2. **Keep changes limited to the concern.** Change only functions and files directly necessary for the approved implementation. Do not alter unrelated functions, behavior, formatting, or structure. If an additional change is necessary, explain the dependency and obtain approval before proceeding.

3. **Explain structural and database integrity impacts.** Before implementation, describe every identified impact on application structure, component relationships, data flow, database schema, constraints, relationships, stored data, and read/write behavior. Explain relevant risks such as data loss, corruption, unintended writes, compatibility breaks, and migration failures, together with proposed safeguards, validation, backup, and rollback steps. State uncertainties and any impacts that cannot yet be verified. If no such impact is expected, say so and explain why. After implementation, report the actual changes, validation results, and remaining risks.

4. **Treat chat as inquiry by default.** Questions, ideas, suggestions, and discussion are not authorization to make changes. Explain or review the proposal without implementing it until the user explicitly instructs you to implement or execute it. That instruction authorizes only the discussed scope; all approval, scope, and structural/database integrity requirements above must still be followed. Read-only inspection remains subject to the live-database safeguards below.

## Existing database behavior

The application uses a shared Supabase database. Legacy versions write during startup and tab switching. The updated synchronization module can upload pending edits during startup, reconnection, and browser focus. Treat browser interaction as potentially mutating. During investigation or validation, block database writes unless the user has explicitly approved them; do not assume that opening the page is read-only.
