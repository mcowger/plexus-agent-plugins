import { log } from "./log.ts";

const PROVIDER_CONNECTION_CLOSED_PATTERN = /\bprovider connection closed\b/i;
const NORMALIZED_PREFIX = "PROVIDER_CONNECTION_CLOSED:";
const NORMALIZED_MESSAGE =
	`${NORMALIZED_PREFIX} Provider connection error: the upstream provider dropped the request. ` +
	"This is a transient provider failure; please retry your request.";

interface ContentBlock {
	type?: string;
}

interface AssistantMessageLike {
	role?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

function hasToolCall(content: unknown): boolean {
	return Array.isArray(content) && (content as ContentBlock[]).some((block) => block?.type === "toolCall");
}

/**
 * Makes a Plexus-specific connection close recognizable to Oh My Pi's native
 * transient-error classifier. OMP event handlers cannot replace messages, so
 * this intentionally updates the finalized message in place before agent-end
 * recovery evaluates it.
 */
export function normalizeProviderConnectionClosed<T extends AssistantMessageLike>(
	message: T,
	providerName: string,
): void {
	if (
		!message ||
		message.role !== "assistant" ||
		message.provider !== providerName ||
		message.stopReason !== "error" ||
		typeof message.errorMessage !== "string" ||
		message.errorMessage.startsWith(NORMALIZED_PREFIX) ||
		hasToolCall(message.content) ||
		!PROVIDER_CONNECTION_CLOSED_PATTERN.test(message.errorMessage)
	) {
		return;
	}

	log("retryable-error: retagged closed provider connection for retry", { model: message.model });
	message.errorMessage = NORMALIZED_MESSAGE;
}
