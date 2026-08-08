// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { MarkdownContent } from "../src/client/markdown.js";

test("code and complete messages expose independent accessible copy actions", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(<MarkdownContent text={"```ts\nconst answer = 42;\n```"} complete />);
  expect(screen.getByText("ts")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy code" }));
  expect(writeText).toHaveBeenCalledWith("const answer = 42;");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Copy message" }));
  expect(writeText).toHaveBeenLastCalledWith("```ts\nconst answer = 42;\n```");
});
