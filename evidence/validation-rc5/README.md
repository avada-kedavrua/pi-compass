# RC5 validation evidence

- `npm-test-core.log`: 82/82 tests pass.
- `npm-test-non-extension.log`: 115/115 tests pass, excluding `tests/extension.test.mjs` because its TypeBox runtime dependency could not be installed in this isolated environment.
- `npm-test-full-blocked.log`: `npm test` output; 115 tests pass but the extension suite fails to load because `typebox` is missing.
- `npm-ci-network-block.txt`: records the `EAI_AGAIN registry.npmjs.org` dependency-install block.
- `contract-report-check.log`: user-supplied pi-subagents@0.83.1 contract report passes 37/37 checks.
- `config-policy-fixture.log`: strict configuration checker passes against temporary settings/runtime proposals and a temporary manifest matching the user-reported 0.83.1 version; this is not a substitute for checking the installed user's files.
- `syntax-checks.log`: JavaScript, JSON and shell syntax checks pass.

The live Pi/provider acceptance was not run here. These records do not claim final v0.8.0 acceptance.
