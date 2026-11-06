import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import agentSchema from "./fixtures/a2ui-upstream/agent_to_renderer.json";
import commonTypes from "./fixtures/a2ui-upstream/common_types.json";
import basicCatalog from "./fixtures/a2ui-upstream/basic_catalog.json";
import fixture from "../packages/contracts/fixtures/a2ui-v1.json";
import workspaceFixture from "./fixtures/a2ui-workspace-media.json";

// Source: a2ui-project/a2ui @ f764873f4795a6ef7c34f91a784e5648b0f9b8ec (Apache-2.0).
// The protocol references an abstract catalog.json. Bind that reference to the
// unmodified component definitions and $defs of the pinned Basic Catalog.
test("the complete shared fixture conforms to the pinned official v1.0 schemas", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(commonTypes);
  ajv.addSchema({
    $id: "https://a2ui.org/specification/v1_0/catalog.json",
    functions: basicCatalog.functions,
    components: basicCatalog.components,
    $defs: {
      ...basicCatalog.$defs,
      anyComponent: { oneOf: Object.values(basicCatalog.components) },
    },
  });
  const validate = ajv.compile(agentSchema);
  for (const candidate of [fixture, workspaceFixture]) {
    expect({ valid: validate(candidate), errors: validate.errors }).toEqual({
      valid: true,
      errors: null,
    });
  }
});
