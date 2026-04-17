import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface WindowInfo {
	id: number;
	name: string;
	owner: string;
}

export default function piSense(pi: ExtensionAPI) {
	let lastTarget: WindowInfo | null = null;
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
		handler: senseHandler,
	});

	async function senseHandler(args: string, ctx: ExtensionCommandContext) {
			const query = args.trim();
			if (!query && !lastTarget) {
				ctx.ui.notify("Usage: /sense <window description>", "warning");
				return;
			}

			const windows = await getVisibleWindows(pi);
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

			const screenshotPath = await captureWindow(pi, target.id);
			if (!screenshotPath) {
				ctx.ui.notify("Failed to capture screenshot.", "error");
				return;
			}

			const label = formatWindow(target);
			const prompt = [
				`[Screenshot of: ${label}]`,
				`Use the read tool to look at the screenshot: ${screenshotPath}`,
			].join("\n");

			lastTarget = target;
			ctx.ui.setEditorText(`${prompt}\n`);
			ctx.ui.notify(`Captured ${label}. Edit the prompt and press Enter to send.`, "info");
		}
}

function formatWindow(w: WindowInfo): string {
	return w.name ? `${w.owner} — ${w.name}` : w.owner;
}

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

	// Score each window: count how many query words appear in the haystack.
	const scored = windows.map((w) => {
		const haystack = `${w.owner} ${w.name}`.toLowerCase();
		const hits = words.filter((word) => haystack.includes(word)).length;
		return { window: w, hits };
	});

	// Keep only windows that matched at least one word.
	const matched = scored.filter((s) => s.hits > 0);
	if (matched.length === 0) return [];

	// Sort by number of hits descending so best matches come first.
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

async function getVisibleWindows(pi: ExtensionAPI): Promise<WindowInfo[]> {
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

async function captureWindow(pi: ExtensionAPI, windowId: number): Promise<string | null> {
	const tmpFile = join(tmpdir(), `pi-sense-${Date.now()}.png`);

	const result = await pi.exec("screencapture", [`-l${windowId}`, "-o", "-x", tmpFile], {
		timeout: 10000,
	});
	if (result.code !== 0) return null;

	return tmpFile;
}

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

async function checkScreenRecording(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("swift", ["-e", SWIFT_CHECK_SCREEN_RECORDING], { timeout: 15000 });
	return result.code === 0 && result.stdout.trim() === "true";
}

const SWIFT_CHECK_ACCESSIBILITY = `
import ApplicationServices
print(AXIsProcessTrusted())
`.trim();

async function checkAccessibility(pi: ExtensionAPI): Promise<boolean> {
	const result = await pi.exec("swift", ["-e", SWIFT_CHECK_ACCESSIBILITY], { timeout: 15000 });
	return result.code === 0 && result.stdout.trim() === "true";
}
