# pi-senses

(Sloppy) Senses for your pi. At least on macos.

A [pi](https://github.com/badlogic/pi-mono) extension that allows your agent to interact with macos windows.

## Senses

All senses require your terminal to have macos specific permissions:

- **Screen Recording** permission for screenshots
- **Accessibility** permission for focus, click, typing, and key presses

Use `/proprioception` to run a quick check.

### Eyes

With eyes, the agent can see:

- **`senses_eyes_list_windows`** lists all visible windows with their numeric IDs, owner app names, and window titles.
- **`senses_eyes_screenshot_window`** captures a screenshot of a window by its numeric ID (as returned by `senses_eyes_list_windows`) and returns the file path to the image.

#### `/look <description>?`

With eyes, the user can direct the agent to look at something:

```
/look ghostty
/look my browser
/look at yourself
/look
```

The command resolves a visible window from your description, captures a screenshot, and prefills your prompt with the image and window metadata. Edit/enrich the prompt, press Enter, and the screenshot is sent to the model.

If the match is ambiguous, you pick from a shortlist.

When no description is given, the last captured window is re-captured.

Simple queries are matched by keyword. When that fails, the current model is used to find the best match from the window list.
