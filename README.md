# pi-sense

(Sloppy) Eyes for your pi. At least on macos.

A [pi](https://github.com/badlogic/pi) extension that captures window screenshots and feeds them into conversations.

## Usage

### User commands

```
/sense outlook
/sense my browser
/sense terminal
/sense
```

The command resolves a visible window from your description, captures a screenshot, and prefills your prompt with the image and window metadata. Edit the prompt text, press Enter, and the screenshot is sent to the model.

If the match is ambiguous, you pick from a shortlist.

When no description is given, the last captured window is re-sensed.

Simple queries are matched by keyword. When that fails, the current model is used to find the best match from the window list.

### Agent tools

The extension also registers two tools the agent can call on its own:

- **`sense_list_windows`** lists all visible windows with their numeric IDs, owner app names, and window titles.
- **`sense_screenshot_window`** captures a screenshot of a window by its numeric ID (as returned by `sense_list_windows`) and returns the file path to the image.

The agent picks the right window from the list itself, so no interactive selection is needed.

## Requirements

- macOS (uses `screencapture` and CoreGraphics via Swift)

## Permissions

macOS requires:
- **Screen Recording** permission for screenshots
- **Accessibility** permission for focus, click, typing, and key presses

Use `/healthcheck-sense` to run a quick check.
