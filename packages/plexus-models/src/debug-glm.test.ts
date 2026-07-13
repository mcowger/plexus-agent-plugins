import { expect, test } from "bun:test";
import { convertToDescriptor } from "./convert.ts";
import type { PlexusApiModel } from "./types.ts";

test("converts GLM 5.2 correctly despite missing top_provider", () => {
    const glmModel: PlexusApiModel = {
        id: "glm-5.2",
        object: "model",
        created: 1783917013,
        owned_by: "plexus",
        preferred_api: ["chat_completions"],
        name: "Glm 5 2",
        architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] }
    };

    const descriptor = convertToDescriptor(glmModel, "https://plexus.home.cowger.us/v1");

    console.log("Descriptor:", descriptor);
    
    // Based on my analysis, maxTokens should be 32768 if missing
    expect(descriptor.maxTokens).toBe(32768);
});
