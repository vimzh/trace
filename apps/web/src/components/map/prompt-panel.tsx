"use client";

import { useEffect, useRef, useState } from "react";
import type { FloorModel } from "@bumps/floor-model";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { mapContent } from "@/data/map";
import { API_URL } from "@/lib/api";
import { cn } from "@/lib/utils";

type HistoryEntry = {
  kind: "applied" | "error" | "question";
  prompt: string;
  reply: string;
};

type PromptPanelProps = {
  acquireMutation: () => boolean;
  disabled: boolean;
  modelVersion: number;
  onApplied: (model: FloorModel, version: number) => void;
  onConflict: () => Promise<void>;
  projectId: string;
  releaseMutation: () => void;
  selectedId: string | null;
};

export function PromptPanel({
  acquireMutation,
  disabled,
  modelVersion,
  onApplied,
  onConflict,
  projectId,
  releaseMutation,
  selectedId,
}: PromptPanelProps) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const scrollRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history, busy]);

  async function submit() {
    const prompt = input.trim();
    if (!prompt || busy || disabled || !acquireMutation()) return;
    setBusy(true);
    setInput("");
    try {
      const response = await fetch(
        `${API_URL}/projects/${projectId}/model/edit`,
        {
          body: JSON.stringify({ prompt, selectedId }),
          headers: {
            "content-type": "application/json",
            "if-match": String(modelVersion),
          },
          method: "POST",
        }
      );
      let payload: {
        action?: "applied" | "clarify";
        error?: string;
        model?: FloorModel;
        question?: string;
        summary?: string;
        version?: number;
      };
      try {
        payload = await response.json();
      } catch (parseError) {
        if (response.ok) await onConflict();
        throw parseError;
      }
      if (
        response.ok &&
        payload.action === "applied" &&
        payload.model &&
        Number.isSafeInteger(payload.version)
      ) {
        onApplied(payload.model, payload.version!);
        setHistory((h) => [
          ...h,
          { kind: "applied", prompt, reply: payload.summary ?? "" },
        ]);
      } else if (response.ok && payload.action === "clarify") {
        setHistory((h) => [
          ...h,
          { kind: "question", prompt, reply: payload.question ?? "" },
        ]);
      } else if (
        response.status === 409 ||
        (response.ok && payload.action === "applied")
      ) {
        await onConflict();
        setHistory((h) => [
          ...h,
          { kind: "error", prompt, reply: mapContent.edit.prompt.failed },
        ]);
      } else {
        setHistory((h) => [
          ...h,
          {
            kind: "error",
            prompt,
            reply: payload.error ?? mapContent.edit.prompt.failed,
          },
        ]);
      }
    } catch {
      setHistory((h) => [
        ...h,
        { kind: "error", prompt, reply: mapContent.edit.prompt.failed },
      ]);
    } finally {
      setBusy(false);
      releaseMutation();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <h2 className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {mapContent.edit.prompt.title}
      </h2>
      <ul
        className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
        ref={scrollRef}
      >
        {history.map((entry, index) => (
          <li className="text-xs" key={index}>
            <p className="font-mono text-muted-foreground">› {entry.prompt}</p>
            <p
              className={cn(
                "mt-1",
                entry.kind === "error" ? "text-destructive" : "text-foreground"
              )}
            >
              {entry.reply}
            </p>
          </li>
        ))}
        {busy && (
          <li className="animate-pulse text-xs text-muted-foreground">
            {mapContent.edit.prompt.busy}
          </li>
        )}
      </ul>
      <div className="flex gap-2 border-t p-2">
        <Input
          className="h-8 rounded-sm text-sm"
          disabled={busy || disabled}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void submit();
            }
          }}
          placeholder={mapContent.edit.prompt.placeholder}
          value={input}
        />
        <Button
          className="h-8 cursor-pointer rounded-sm px-3 text-xs"
          disabled={busy || disabled || input.trim() === ""}
          onClick={() => void submit()}
          size="sm"
          type="button"
        >
          {mapContent.edit.prompt.send}
        </Button>
      </div>
    </div>
  );
}
