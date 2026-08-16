import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest"

beforeAll(() => {
  window.history.replaceState({}, "", "/veritly/workspace?frame=dataprep%3Aproject&parentOrigin=http%3A%2F%2Flocalhost&api=http%3A%2F%2Fdata.localhost")
})

afterEach(() => cleanup())

describe("Veritly preparation studio", () => {
  test("navigates sheets, exposes empty selections, and rebinds another workbook", async () => {
    const { App } = await import("../../src/veritly/studio")
    const post = vi.spyOn(window, "postMessage").mockImplementation(() => undefined)
    const state = { file: "file-1", path: "Sales.xlsx", revision: 4, version: 1 }
    const fetcher = vi.spyOn(window, "fetch").mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith("/rebind")) {
        const body = JSON.parse(String(init?.body)) as { expectedVersion: number; workbook: string }
        expect(body).toEqual({ expectedVersion: 1, workbook: "Archive.xlsx" })
        state.file = "file-2"
        state.path = body.workbook
        state.revision = 2
        state.version = 2
        return Response.json(prep(state))
      }
      if (url.endsWith("/preps/recipe")) return Response.json({
        ...prep(state),
      })
      if (url.endsWith("/project")) return Response.json({
        id: "project",
        state: "unprovisioned",
        quota: { used: 0, limit: 10_737_418_240, percent: 0 },
        revision: 0,
        preps: [],
      })
      if (url.endsWith("/datasets")) return Response.json({ datasets: [] })
      if (url.endsWith("/issues")) return Response.json({ issues: [] })
      if (url.endsWith("/workbooks")) return Response.json({
        workbooks: [
          { file: "file-2", path: "Archive.xlsx", revision: 2, updated: 2 },
          { file: "file-1", path: "Sales.xlsx", revision: 4, updated: 1 },
        ],
      })
      if (url.endsWith("/mapping")) return Response.json({
        prep: "recipe",
        version: state.version,
        state: "draft",
        source: { kind: "workbook", file: state.file, path: state.path, revision: state.revision },
        sources: [],
        targets: [],
      })
      if (url.endsWith("/workbook")) return Response.json({
        file: state.file,
        revision: state.revision,
        sheets: state.path === "Archive.xlsx" ? [{
          name: "History",
          rows: { start: 1, end: 50 },
          columns: { start: 1, end: 6 },
          visibility: "visible",
          regions: [{ header: 1, start: 2, end: 50, left: 1, right: 6 }],
        }] : [
          {
            name: "Transactions",
            rows: { start: 1, end: 1_000 },
            columns: { start: 1, end: 20 },
            visibility: "visible",
            regions: [
              { header: 2, start: 3, end: 1_000, left: 2, right: 5 },
              { header: 2, start: 3, end: 20, left: 9, right: 10 },
            ],
          },
          {
            name: "Empty",
            rows: { start: 1, end: 1 },
            columns: { start: 1, end: 1 },
            visibility: "visible",
            regions: [],
          },
        ],
      })
      throw new Error(`Unexpected data request: ${url}`)
    })
    render(<App />)

    receive({
      type: "veritly.iframe.open",
      frame: "dataprep:project",
      request: 1,
      path: "Sales.prep",
      payload: { recipe: "recipe", project: "project" },
    })

    expect(await screen.findByText("Choose a table-like region")).toBeVisible()
    expect(screen.getByText("Suggested table 1")).toBeVisible()
    expect(screen.getByText("Suggested table 2")).toBeVisible()

    fireEvent.click(screen.getByRole("button", { name: /Empty 0 suggested tables/ }))
    expect(await screen.findByText("No table-like range was detected. Enter the exact worksheet bounds below.")).toBeVisible()
    expect(screen.getAllByRole("button", { name: "Analyze selection" }).every((button) => button.hasAttribute("disabled"))).toBe(true)

    fireEvent.click(screen.getByRole("button", { name: /Transactions 2 suggested tables/ }))
    fireEvent.click(screen.getByRole("button", { name: /Suggested table 2/ }))
    expect(screen.getAllByText("I2:J20 · 18 rows")).toHaveLength(2)
    expect(screen.getAllByRole("button", { name: "Analyze selection" }).every((button) => !button.hasAttribute("disabled"))).toBe(true)

    fireEvent.change(screen.getByRole("spinbutton", { name: "Header row" }), { target: { value: "5" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "First data row" }), { target: { value: "7" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Last data row" }), { target: { value: "44" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "First column" }), { target: { value: "3" } })
    fireEvent.change(screen.getByRole("spinbutton", { name: "Last column" }), { target: { value: "7" } })
    expect(screen.getByText("C5:G44 · 38 rows")).toBeVisible()

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "Workbook" }))
    fireEvent.click(await screen.findByRole("option", { name: "Archive.xlsx · r2" }))
    expect(await screen.findByText("History")).toBeVisible()
    expect(screen.getAllByText("A1:F50 · 49 rows")).toHaveLength(2)

    post.mockRestore()
    fetcher.mockRestore()
  })
})

function prep(state: { file: string; path: string; revision: number; version: number }) {
  return {
    id: "recipe",
    project: "project",
    path: "Sales.prep",
    schema: "sales_abcd1234",
    source: { kind: "workbook" as const, file: state.file, path: state.path, revision: state.revision },
    version: state.version,
    state: "draft" as const,
    commands: [],
    created: 1,
    updated: 1,
  }
}

function receive(data: unknown) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data, origin: "http://localhost", source: window })))
}
