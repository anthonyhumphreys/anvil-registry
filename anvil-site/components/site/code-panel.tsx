import { Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CodePanel({
  command,
  output,
  title = "Terminal"
}: {
  command: string;
  output: string[];
  title?: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-anvil">
      <div className="flex items-center justify-between border-b bg-muted/60 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="size-4" aria-hidden="true" />
          {title}
        </div>
        <Button variant="ghost" size="icon" aria-label="Copy command">
          <Copy aria-hidden="true" />
        </Button>
      </div>
      <pre className="code-window min-h-64 overflow-x-auto p-5 font-mono text-sm leading-7 text-white">
        <code>
          <span className="text-amber-300">{command}</span>
          {"\n"}
          {output.map((line) => (
            <span key={line}>
              {line}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
