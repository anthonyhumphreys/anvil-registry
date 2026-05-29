import Link from "next/link";
import { cn } from "@/lib/utils";
import { groupDocs, type DocMeta } from "@/lib/docs";

export function DocsNav({
  docs,
  activeSlug
}: {
  docs: Array<DocMeta & { slug: string }>;
  activeSlug?: string;
}) {
  return (
    <nav className="flex flex-col gap-7 text-sm" aria-label="Documentation navigation">
      {groupDocs(docs).map(([section, entries]) => (
        <div key={section} className="flex flex-col gap-2">
          <p className="px-3 text-xs font-semibold uppercase tracking-normal text-muted-foreground">{section}</p>
          <div className="flex flex-col gap-1">
            {entries.map((entry) => (
              <Link
                key={entry.slug}
                href={`/docs/${entry.slug}`}
                className={cn(
                  "rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  activeSlug === entry.slug && "bg-muted font-medium text-foreground"
                )}
              >
                {entry.title}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
