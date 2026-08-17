import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { openFileExplorer } from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

let workspace: SeededWorkspace;
let localDir: string;

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "file-explorer-upload-" });
  localDir = mkdtempSync(path.join(tmpdir(), "file-explorer-upload-local-"));
});

test.afterEach(async () => {
  await workspace?.cleanup();
  rmSync(localDir, { recursive: true, force: true });
});

test("uploads a local file into a workspace folder and lists it", async ({ page }) => {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);

  await page.getByTestId("files-new-folder").click();
  const nameInput = page.getByTestId("file-explorer-name-input");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("uploads");
  await nameInput.press("Enter");

  const tree = page.getByTestId("file-explorer-tree-scroll");
  const uploadsFolder = tree.getByText("uploads", { exact: true }).first();
  await expect(uploadsFolder).toBeVisible();
  await uploadsFolder.click({ button: "right" });

  const localFile = path.join(localDir, "local-upload.txt");
  writeFileSync(localFile, "uploaded from the browser", "utf8");

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByTestId(/file-explorer-row-\d+-upload$/).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(localFile);

  await uploadsFolder.click();
  await expect(tree.getByText("local-upload.txt", { exact: true })).toBeVisible();
  expect(
    readFileSync(path.join(workspace.workspaceDirectory, "uploads", "local-upload.txt"), "utf8"),
  ).toBe("uploaded from the browser");
});
