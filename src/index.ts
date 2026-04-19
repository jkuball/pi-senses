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
	const tmpFile = join(tmpdir(), `pi-senses-${Date.now()}.png`);

	const result = await pi.exec("screencapture", [`-l${windowId}`, "-o", "-x", tmpFile], {
		timeout: 10000,
	});
	if (result.code !== 0) return null;

	return tmpFile;
}

async function clickWindow(pi: ExtensionAPI, windowId: number, x: number, y: number): Promise<{ ok: boolean; error?: string }> {
	const script = SWIFT_CLICK
		.replace("__WINDOW_ID__", String(windowId))
		.replace("__X__", String(x))
		.replace("__Y__", String(y));

	const result = await pi.exec("swift", ["-e", script], { timeout: 15000 });
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || "Swift click script failed" };
	}

	const output = result.stdout.trim();
	if (output.startsWith("ERROR:")) {
		return { ok: false, error: output };
	}

	return { ok: true };
}

async function typeInWindow(pi: ExtensionAPI, windowId: number, text: string): Promise<{ ok: boolean; error?: string }> {
	// Escape the text for embedding in Swift source: backslashes first, then quotes and newlines
	const escaped = text
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");

	const script = SWIFT_TYPE
		.replace("__WINDOW_ID__", String(windowId))
		.replace("__TEXT__", escaped);

	const result = await pi.exec("swift", ["-e", script], { timeout: 30000 });
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || "Swift type script failed" };
	}

	const output = result.stdout.trim();
	if (output.startsWith("ERROR:")) {
		return { ok: false, error: output };
	}

	return { ok: true };
}

async function sendKeyInWindow(pi: ExtensionAPI, windowId: number, key: string, modifiers: string[]): Promise<{ ok: boolean; error?: string }> {
	const modJson = JSON.stringify(modifiers);
	const script = SWIFT_KEY
		.replace("__WINDOW_ID__", String(windowId))
		.replace("__KEY__", key)
		.replace("__MODIFIERS__", modJson);

	const result = await pi.exec("swift", ["-e", script], { timeout: 15000 });
	if (result.code !== 0) {
		return { ok: false, error: result.stderr.trim() || "Swift key script failed" };
	}

	const output = result.stdout.trim();
	if (output.startsWith("ERROR:")) {
		return { ok: false, error: output };
	}

	return { ok: true };
}

// ── Extension entry point ────────────────────────────────────────────

export default function piSense(pi: ExtensionAPI) {
	let lastTarget: WindowInfo | null = null;

	// ── Commands ──

	pi.registerCommand("proprioception", {
		description: "Check macOS permissions required by pi-senses",
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

	pi.registerCommand("look", {
		description: "Capture a window screenshot by description (macOS)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const query = args.trim();
			if (!query && !lastTarget) {
				ctx.ui.notify("Usage: /look <window description>", "warning");
				return;
			}

			const windows = await listWindows(pi);
			if (windows.length === 0) {
				ctx.ui.notify("No visible windows found.", "warning");
				return;
			}

			let target: WindowInfo;

			if (!query) {
				// Re-look: find the same window by owner+name in the current window list.
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
					ctx.ui.notify(`No windows matching "/look ${query}".`, "warning");
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
				`[Screenshot of: ${label}] (windowId=${target.id})`,
				`Use the read tool to look at the screenshot: ${path}`,
			].join("\n");

			lastTarget = target;
			ctx.ui.setEditorText(`${prompt}\n`);
			ctx.ui.notify(`Captured '${label}'. Edit the prompt and press Enter to send.`, "info");
		},
	});

	// ── Agent tools ──

	pi.registerTool({
		name: "senses__eyes__list_windows",
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
		name: "senses__eyes__screenshot_window",
		label: "Screenshot Window",
		description: "Capture a screenshot of a specific window by its numeric window ID (as returned by senses__eyes__list_windows). Returns the file path to the screenshot image.",
		promptSnippet: "Capture a screenshot of a macOS window by ID",
		promptGuidelines: [
			"Call senses__eyes__list_windows first to discover window IDs, then use senses__eyes__screenshot_window with the desired ID.",
			"After capturing, use the read tool on the returned path to view the screenshot.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "The numeric window ID from senses__eyes__list_windows" }),
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

	pi.registerTool({
		name: "senses__hands__type",
		label: "Type Text",
		description:
			"Type text into a window. Takes a window ID and the text to type. " +
			"The tool automatically activates the target app and types each character sequentially.",
		promptSnippet: "Type text into a macOS window",
		promptGuidelines: [
			"Use senses__hands__click first to focus the correct text field, then use senses__hands__type to enter text.",
			"For special keys like Enter, Tab, Escape, or keyboard shortcuts, use senses__hands__key instead.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "The numeric window ID from senses__eyes__list_windows" }),
			text: Type.String({ description: "The text to type" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await typeInWindow(pi, params.windowId, params.text);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Type failed: ${result.error}` }],
					details: {},
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Typed ${params.text.length} character(s) into window ${params.windowId}.` }],
				details: { windowId: params.windowId, textLength: params.text.length },
			};
		},
	});

	pi.registerTool({
		name: "senses__hands__key",
		label: "Send Key",
		description:
			"Send a key press to a window, optionally with modifier keys. " +
			"Takes a window ID, a key name, and optional modifiers. " +
			"The tool automatically activates the target app and sends the key event.",
		promptSnippet: "Send a key press (with optional modifiers) to a macOS window",
		promptGuidelines: [
			"Supported keys: return, tab, escape, space, delete, forwarddelete, " +
			"uparrow, downarrow, leftarrow, rightarrow, home, end, pageup, pagedown, " +
			"f1-f12, plus any single character (a-z, 0-9, punctuation).",
			"Supported modifiers: command, shift, option, control. Pass as an array, e.g. [\"command\", \"shift\"].",
			"Examples: key='return' for Enter, key='a' modifiers=['command'] for Cmd+A, key='tab' for Tab.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "The numeric window ID from senses__eyes__list_windows" }),
			key: Type.String({ description: "The key to press (e.g. 'return', 'tab', 'escape', 'a', 'f1')" }),
			modifiers: Type.Optional(Type.Array(Type.String({ description: "Modifier key: command, shift, option, or control" }), { description: "Optional modifier keys to hold during the key press" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const mods = params.modifiers ?? [];
			const result = await sendKeyInWindow(pi, params.windowId, params.key, mods);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Key press failed: ${result.error}` }],
					details: {},
					isError: true,
				};
			}
			const desc = mods.length > 0 ? `${mods.join("+")}+${params.key}` : params.key;
			return {
				content: [{ type: "text", text: `Sent key '${desc}' to window ${params.windowId}.` }],
				details: { windowId: params.windowId, key: params.key, modifiers: mods },
			};
		},
	});

	pi.registerTool({
		name: "senses__hands__click",
		label: "Click Window",
		description:
			"Click a point in a window. Takes a window ID and (x, y) coordinates in screenshot pixels. " +
			"The tool automatically activates the app, converts pixel coordinates to screen points " +
			"(accounting for Retina scaling), and performs the click.",
		promptSnippet: "Click a point in a macOS window by window ID and screenshot pixel coordinates",
		promptGuidelines: [
			"Use senses__eyes__screenshot_window first to see the window, then identify the (x, y) pixel coordinates of the element to click in the screenshot image.",
			"Coordinates are in screenshot pixels (not points). The tool handles Retina scaling internally.",
		],
		parameters: Type.Object({
			windowId: Type.Number({ description: "The numeric window ID from senses__eyes__list_windows" }),
			x: Type.Number({ description: "X coordinate in screenshot pixels" }),
			y: Type.Number({ description: "Y coordinate in screenshot pixels" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await clickWindow(pi, params.windowId, params.x, params.y);
			if (!result.ok) {
				return {
					content: [{ type: "text", text: `Click failed: ${result.error}` }],
					details: {},
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Clicked at (${params.x}, ${params.y}) in window ${params.windowId}.` }],
				details: { windowId: params.windowId, x: params.x, y: params.y },
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

	const matched = scored.filter((s) => s.hits === words.length);
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

	ctx.ui.setStatus("pi-senses", `Sensing "/look ${query}"...`);
	let response;
	try {
		response = await complete(
			model,
			{
				systemPrompt: [
					"You are part of the pi-senses extension and live inside the coding harness 'pi'.",
					"You must match a user's window description to a list of open windows.",
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
								text: `Windows:\n${windowList}\n\nUser query: "/look ${query}"`,
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
		ctx.ui.setStatus("pi-senses", undefined);
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

const SWIFT_CLICK = `
import AppKit
import CoreGraphics
import Foundation

let targetWindowId: UInt32 = __WINDOW_ID__
let pixelX: CGFloat = __X__
let pixelY: CGFloat = __Y__

// Find the window info to get bounds and PID
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("ERROR: Cannot list windows")
    exit(1)
}

var windowBounds: CGRect?
var windowPID: Int32?

for info in list {
    guard let id = info["kCGWindowNumber"] as? UInt32, id == targetWindowId,
          let bounds = info["kCGWindowBounds"] as? [String: Any],
          let x = bounds["X"] as? CGFloat,
          let y = bounds["Y"] as? CGFloat,
          let w = bounds["Width"] as? CGFloat,
          let h = bounds["Height"] as? CGFloat,
          let pid = info["kCGWindowOwnerPID"] as? Int32 else { continue }
    windowBounds = CGRect(x: x, y: y, width: w, height: h)
    windowPID = pid
    break
}

guard let bounds = windowBounds, let pid = windowPID else {
    print("ERROR: Window \(targetWindowId) not found")
    exit(1)
}

// Determine the display scale factor for the screen the window is on
var displayCount: UInt32 = 0
CGGetActiveDisplayList(0, nil, &displayCount)
var displays = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
CGGetActiveDisplayList(displayCount, &displays, &displayCount)

var scaleFactor: CGFloat = 2.0 // safe default
for d in displays {
    let db = CGDisplayBounds(d)
    if db.contains(CGPoint(x: bounds.midX, y: bounds.midY)) {
        if let mode = CGDisplayCopyDisplayMode(d) {
            scaleFactor = CGFloat(mode.pixelWidth) / CGFloat(mode.width)
        }
        break
    }
}

// Convert screenshot pixels to screen points
let pointX = bounds.origin.x + (pixelX / scaleFactor)
let pointY = bounds.origin.y + (pixelY / scaleFactor)
let clickPoint = CGPoint(x: pointX, y: pointY)

// Activate the owning app
if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate()
    usleep(300_000) // wait for app to come to front
}

// Perform the click
guard let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: clickPoint, mouseButton: .left),
      let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: clickPoint, mouseButton: .left) else {
    print("ERROR: Cannot create mouse events")
    exit(1)
}

mouseDown.post(tap: .cghidEventTap)
usleep(100_000)
mouseUp.post(tap: .cghidEventTap)

print("OK: clicked at (\(clickPoint.x), \(clickPoint.y)) scale=\(scaleFactor)")
`.trim();

const SWIFT_TYPE = `
import AppKit
import CoreGraphics
import Foundation

let targetWindowId: UInt32 = __WINDOW_ID__
let text = "__TEXT__"

// Find window PID
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("ERROR: Cannot list windows")
    exit(1)
}

var windowPID: Int32?
for info in list {
    guard let id = info["kCGWindowNumber"] as? UInt32, id == targetWindowId,
          let pid = info["kCGWindowOwnerPID"] as? Int32 else { continue }
    windowPID = pid
    break
}

guard let pid = windowPID else {
    print("ERROR: Window \\(targetWindowId) not found")
    exit(1)
}

// Activate the owning app
if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate()
    usleep(300_000)
}

// Type each character using CGEvent with unicode string
for char in text {
    var chars = Array(String(char).utf16)
    guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        print("ERROR: Cannot create keyboard events")
        exit(1)
    }
    keyDown.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
    keyUp.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    usleep(20_000)
}

print("OK: typed \\(text.count) character(s)")
`.trim();

const SWIFT_KEY = `
import AppKit
import CoreGraphics
import Foundation

let targetWindowId: UInt32 = __WINDOW_ID__
let keyName = "__KEY__"
let modifierNames: [String] = {
    let json = """\n__MODIFIERS__\n"""
    guard let data = json.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
    return arr
}()

// Virtual keycode lookup
let keyCodes: [String: UInt16] = [
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
    "delete": 0x33, "backspace": 0x33, "forwarddelete": 0x75,
    "escape": 0x35, "esc": 0x35,
    "uparrow": 0x7E, "up": 0x7E, "downarrow": 0x7D, "down": 0x7D,
    "leftarrow": 0x7B, "left": 0x7B, "rightarrow": 0x7C, "right": 0x7C,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E,
    "f": 0x03, "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26,
    "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D, "o": 0x1F,
    "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
    "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10,
    "z": 0x06,
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
    "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\\\": 0x2A,
    ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
    "\`": 0x32,
]

// Resolve keycode
guard let keyCode = keyCodes[keyName.lowercased()] else {
    print("ERROR: Unknown key '\\(keyName)'. Supported: \\(keyCodes.keys.sorted().joined(separator: ", "))")
    exit(1)
}

// Build modifier flags
var flags: CGEventFlags = []
for mod in modifierNames {
    switch mod.lowercased() {
    case "command", "cmd": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "option", "alt": flags.insert(.maskAlternate)
    case "control", "ctrl": flags.insert(.maskControl)
    default:
        print("ERROR: Unknown modifier '\\(mod)'. Supported: command, shift, option, control")
        exit(1)
    }
}

// Find window PID
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let windowList = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    print("ERROR: Cannot list windows")
    exit(1)
}

var windowPID: Int32?
for info in windowList {
    guard let id = info["kCGWindowNumber"] as? UInt32, id == targetWindowId,
          let pid = info["kCGWindowOwnerPID"] as? Int32 else { continue }
    windowPID = pid
    break
}

guard let pid = windowPID else {
    print("ERROR: Window \\(targetWindowId) not found")
    exit(1)
}

// Activate the owning app
if let app = NSRunningApplication(processIdentifier: pid) {
    app.activate()
    usleep(300_000)
}

// Send key event
guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
    print("ERROR: Cannot create keyboard events")
    exit(1)
}

if !flags.isEmpty {
    keyDown.flags = flags
    keyUp.flags = flags
}

keyDown.post(tap: .cghidEventTap)
usleep(100_000)
keyUp.post(tap: .cghidEventTap)

let modStr = modifierNames.isEmpty ? "" : modifierNames.joined(separator: "+") + "+"
print("OK: sent \\(modStr)\\(keyName)")
`.trim();

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
