import { z } from "zod";

/** Abbreviated display name for one Plexus model, carried on the committed model object. */
export const ShortNameEntrySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		shortName: z.string().min(1).max(200),
	})
	.strict();

export type ShortNameEntry = z.infer<typeof ShortNameEntrySchema>;
