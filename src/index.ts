import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface WindowInfo {
	id: number;
	name: string;
	owner: string;
}

// ── Core helpers (shared by tools and commands) ──────────────────────

function formatWindow(w: WindowInfo): string {
	return w.name ? `${w.owner} — ${w.name}` : w.owner;
}

async function listWindows(pi: ExtensionAPI): Promise<WindowInfo[]> {
	const result = await pi.exec("swift", ["-e", SWIFT_WINDOW_LIST], {
		timeout: 15000,
	});
	if (result.code !== 0) return [];

	try {
		const windows: WindowInfo[] = JSON.parse(result.stdout.trim());

		// Deduplicate: keep unique (owner, name) pairs, prefer first occurrence.
		const seen = new Set<string>();
		return windows.filter((w) => {
			const key = `${w.owner}\0${w.name}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	} catch {
		return [];
	}
}

async function screenshotWindow(pi: ExtensionAPI, windowId: number): Promise<string | null> {
	const tmpFile = join(tmpdir(), `pi-sense-${Date.now()}.png`);

	const result = await pi.exec("screencapture", [`-l${windowId}`, "-o", "-x", tmpFile], {
		timeout: 10000,
	});
	if (result.code !== 0) return null;

	return tmpFile;
}

// ── Extension entry point ────────────────────────────────────────────

export default function piSense(pi: ExtensionAPI) {
	let lastTarget: WindowInfo | null = null;

	// ── Commands ──

	pi.registerCommand("healthcheck-sense", {
		description: "Check macOS permissions required by pi-sense",
		handler: async (_args, ctx) => {
			const screenRecording = await checkScreenRecording(pi);
			const accessibility = await checkAccessibility(pi);

			const icon = (ok: boolean) => (ok ? "✅" : "❌");
			const lines = [
				`${icon(screenRecording)} Screen Recording (screenshots)`,
				`${icon(accessibility)} Accessibility (focus, click, typing, key presses)`,
			];

			if (screenRecording && accessibility) {
				ctx.ui.notify(`All permissions granted.\n${lines.join("\n")}`, "info");
			} else {
				ctx.ui.notify(
					`Missing permissions. Grant them in System Settings > Privacy & Security.\n${lines.join("\n")}`,
					"warning",
				);
			}
		},
	});

	pi.registerCommand("sense", {
		description: "Capture a window screenshot by description (macOS)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const query = args.trim();
			if (!query && !lastTarget) {
				ctx.ui.notify("Usage: /sense <window description>", "warning");
				return;
			}

			const windows = await listWindows(pi);
			if (windows.length === 0) {
				ctx.ui.notify("No visible windows found.", "warning");
				return;
			}

			let target: WindowInfo;

			if (!query) {
				// Re-sense: find the same window by owner+name in the current window list.
				const match = windows.find(
					(w) => w.owner === lastTarget!.owner && w.name === lastTarget!.name,
				);
				if (!match) {
					ctx.ui.notify(`Previous window (${formatWindow(lastTarget!)}) is no longer visible.`, "warning");
					return;
				}
				target = match;
			} else {
				const matches = await resolveWindows(pi, ctx, windows, query);

				if (matches.length === 0) {
					ctx.ui.notify(`No windows matching "${query}".`, "warning");
					return;
				} else if (matches.length === 1) {
					target = matches[0];
				} else {
					const labels = matches.map(formatWindow);
					const choice = await ctx.ui.select(`Multiple windows match "${query}":`, labels);
					if (!choice) return;
					target = matches[labels.indexOf(choice)];
				}
			}

			const path = await screenshotWindow(pi, target.id);
			if (!path) {
				ctx.ui.notify("Failed to capture screenshot.", "error");
				return;
			}

			const label = formatWindow(target);
			const prompt = [
				`[Screenshot of: ${label}]`,
				`Use the read tool to look at the screenshot: ${path}`,
			].join("\n");

			lastTarget = target;
			ctx.ui.setEditorText(`${prompt}\n`);
			ctx.ui.notify(`Captured ${label}. Edit the prompt and press Enter to send.`, "info");
		},
	});

	// ── Agent tools ──

	pi.registerTool({
		name: "sense_list_windows",
		label: "List Windows",
		description: "List all visible windows on macOS. Returns window IDs, owner app names, and window titles.",
		promptSnippet: "List visible macOS windows (id, owner, name)",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const windows = await listWindows(pi);
			if (windows.length === 0) {
				return {
					content: [{ type: "text", text: "No visible windows found." }],
					details: {},
				};
			}
			const listing = windows.map((w) => `id=${w.id}  ${formatWindow(w)}`).join("\n");
			return {
				content: [{ type: "text", text: listing }],
				details: { windows },
			};
		},
	});

	pi.registerTool({
		name: "sense_screenshot_window",
		label: "Screenshot Window",
		description: "Capture a screenshot of a specific window by its numeric window ID (as returned by sense_list_windows). Returns the file path to the screenshot image.",
		promptSnippet: "Capture a screenshot of a macOS window by ID",
		promptGuidelines: [
			"Call sense_list_windows first to discover window IDs, then use sense_screenshot_window with the desired ID.",
			"After capturing, use the read tool on the returned path to view the screenshot.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "The numeric window ID from sense_list_windows" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const path = await screenshotWindow(pi, params.windowId);
			if (!path) {
				return {
					content: [{ type: "text", text: "Failed to capture screenshot." }],
					details: {},
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Screenshot saved to: ${path}\nUse the read tool to view it.` }],
				details: { path, windowId: params.windowId },
			};
		},
	});
}

// ── Window resolution (interactive command only) ─────────────────────

async function resolveWindows(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	windows: WindowInfo[],
	query: string,
): Promise<WindowInfo[]> {
	// Try simple keyword matching first.
	const keywordMatches = matchWindowsByKeyword(windows, query);
	if (keywordMatches.length > 0) return keywordMatches;

	// Fall back to LLM resolution.
	return resolveWindowsWithLLM(pi, ctx, windows, query);
}

function matchWindowsByKeyword(windows: WindowInfo[], query: string): WindowInfo[] {
	const words = query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);

	const scored = windows.map((w) => {
		const haystack = `${w.owner} ${w.name}`.toLowerCase();
		const hits = words.filter((word) => haystack.includes(word)).length;
		return { window: w, hits };
	});

	const matched = scored.filter((s) => s.hits > 0);
	if (matched.length === 0) return [];

	matched.sort((a, b) => b.hits - a.hits);
	return matched.map((s) => s.window);
}

async function resolveWindowsWithLLM(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	windows: WindowInfo[],
	query: string,
): Promise<WindowInfo[]> {
	const model = ctx.model;
	if (!model) {
		ctx.ui.notify("No model selected, cannot resolve window by description.", "warning");
		return [];
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		ctx.ui.notify("No API key available for LLM window resolution.", "warning");
		return [];
	}

	const windowList = windows
		.map((w, i) => `${i}: ${formatWindow(w)}`)
		.join("\n");

	ctx.ui.setStatus("pi-sense", `Sensing "${query}"...`);
	let response;
	try {
		response = await complete(
			model,
			{
				systemPrompt: [
					"You match a user's window description to a list of open windows.",
					"Return ONLY the numeric indices of matching windows, one per line.",
					"Return the best matches (can be more than one if ambiguous).",
					"If nothing matches, return the single word NONE.",
					"Do not output anything else.",
				].join(" "),
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: `Windows:\n${windowList}\n\nUser query: "${query}"`,
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: 128,
			},
		);
	} finally {
		ctx.ui.setStatus("pi-sense", undefined);
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	if (text === "NONE") return [];

	const indices = text
		.split(/\n/)
		.map((line) => parseInt(line.trim(), 10))
		.filter((i) => !isNaN(i) && i >= 0 && i < windows.length);

	return indices.map((i) => windows[i]);
}

// ── Swift snippets ───────────────────────────────────────────────────

const SWIFT_WINDOW_LIST = `
import CoreGraphics
import Foundation

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("[]")
    exit(0)
}

var result: [[String: Any]] = []
for info in list {
    guard let layer = info["kCGWindowLayer"] as? Int, layer == 0,
          let owner = info["kCGWindowOwnerName"] as? String,
          let id = info["kCGWindowNumber"] as? Int else { continue }
    let name = info["kCGWindowName"] as? String ?? ""
    result.append(["id": id, "name": name, "owner": owner])
}

let data = try JSONSerialization.data(withJSONObject: result)
print(String(data: data, encoding: .utf8)!)
`.trim();

const SWIFT_CHECK_SCREEN_RECORDING = `
import CoreGraphics
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("false")
    exit(0)
}
let hasNames = list.contains { ($0["kCGWindowName"] as? String) != nil }
print(hasNames ? "true" : "false")
`.trim();

const SWIFT_CHECK_ACCESSIBILITY = `
import ApplicationServices
print(AXIsProcessTrusted())
`.trim();

// ── Permission checks ───────────────────────────────────────────────

async function checkScreenRecording(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("swift", ["-e", SWIFT_CHECK_SCREEN_RECORDING], { timeout: 15000 });
	return result.code === 0 && result.stdout.trim() === "true";
}

async function checkAccessibility(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("swift", ["-e", SWIFT_CHECK_ACCESSIBILITY], { timeout: 15000 });
	return result.code === 0 && result.stdout.trim() === "true";
}
