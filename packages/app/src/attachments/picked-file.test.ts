import { describe, expect, test } from "vitest";
import { baseNameFromPath } from "./picked-file.js";

describe("baseNameFromPath", () => {
  test("extracts the base name from a Windows backslash path", () => {
    expect(baseNameFromPath("C:\\Users\\0\\Desktop\\aaaa.txt")).toBe("aaaa.txt");
  });

  test("extracts the base name from a POSIX slash path", () => {
    expect(baseNameFromPath("/home/user/Documents/notes.md")).toBe("notes.md");
  });

  test("extracts the base name from a mixed separator path", () => {
    expect(baseNameFromPath("C:/Users/0/Desktop\\mixed.txt")).toBe("mixed.txt");
  });

  test("returns the value unchanged when it has no separator", () => {
    expect(baseNameFromPath("report.pdf")).toBe("report.pdf");
  });

  test("handles a trailing separator", () => {
    expect(baseNameFromPath("C:\\Users\\0\\folder\\")).toBe("folder");
  });
});
