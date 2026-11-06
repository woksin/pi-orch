import { resolve } from "node:path";

export interface ShellInvocation { name: string; input: unknown; cwd: string; command?: string }
export interface ShellInvocations { calls: ShellInvocation[]; error?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fields: Record<string, string> = { bash: "command", job_start: "command", job_watch: "check", job_subscribe: "check" };
export const MALFORMED_EXECUTION = "Execution guard: malformed execution input or nested-tool depth exceeded.";

const invalid = (): ShellInvocations => ({ calls: [], error: MALFORMED_EXECUTION });
const validCwd = (input: Record<string, unknown>) => input.cwd === undefined || typeof input.cwd === "string" && (input.cwd === "" || !!input.cwd.trim());
const validChild = (child: unknown): child is { recipient_name: string; parameters: unknown } => record(child) && typeof child.recipient_name === "string" && !!child.recipient_name.trim();
function nestedInvocations(input: Record<string, unknown>, cwd: string, depth: number): ShellInvocations {
	if (!Array.isArray(input.tool_uses)) return invalid();
	const calls: ShellInvocation[] = [];
	for (const child of input.tool_uses) {
		if (!validChild(child)) return invalid();
		const nested = shellInvocations(child.recipient_name, child.parameters, cwd, depth + 1);
		if (nested.error) return nested;
		calls.push(...nested.calls);
	}
	return { calls };
}
function executionInvocations(name: string, input: Record<string, unknown>, cwd: string, depth: number, field?: string): ShellInvocations {
	if (!field) return nestedInvocations(input, cwd, depth);
	const executionCwd = name !== "bash" && typeof input.cwd === "string" ? resolve(cwd, input.cwd) : cwd;
	if (typeof input[field] !== "string" || !input[field].trim()) return invalid();
	return { calls: [{ name, input, cwd: executionCwd, command: input[field] }] };
}
const isPromise = (value: any): value is Promise<any> => value && typeof value.then === "function";

/** Only explicit execution envelopes are code. Unknown tools remain opaque leaves. */
export function shellInvocations(name: string, input: unknown, cwd: string, depth = 0): ShellInvocations {
	name = name.replace(/^functions\./, "");
	const wrapper = name === "multi_tool_use" || name === "multi_tool_use.parallel";
	const field = Object.hasOwn(fields, name) ? fields[name] : undefined;
	if (depth > 4) return invalid();
	if (!wrapper && !field) return { calls: [{ name, input, cwd }] };
	if (!record(input) || field && name !== "bash" && !validCwd(input)) return invalid();
	return executionInvocations(name, input, cwd, depth, field);
}

/** Session authority stays intact; only the internal third argument names the execution target. */
export function shellGuard(handler: (event: any, ctx: any, executionCwd: string) => any, enabled: (event: any, ctx: any) => boolean = () => true) {
	return (event: any, ctx: any) => {
		if (!enabled(event, ctx)) return handler(event, ctx, ctx?.cwd ?? process.cwd());
		const normalized = shellInvocations(event.toolName, event.input, ctx?.cwd ?? process.cwd());
		if (normalized.error) return { block: true, reason: normalized.error };
		const run = (index: number): any => {
			const call = normalized.calls[index];
			if (!call) return;
			const next = { ...event, toolName: call.command === undefined ? call.name : "bash", input: call.command === undefined ? call.input : { ...(call.input as object), command: call.command } };
			const result = handler(next, ctx, call.cwd);
			const proceed = (verdict: any) => verdict?.block ? verdict : run(index + 1);
			return isPromise(result) ? result.then(proceed) : proceed(result);
		};
		return run(0);
	};
}
