import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { marked } from "marked";

const docsDirectory = path.join(process.cwd(), "content", "docs");

export type DocMeta = {
  title: string;
  description: string;
  section: string;
  order: number;
};

export type DocPage = DocMeta & {
  slug: string;
  contentHtml: string;
};

marked.use({
  gfm: true,
  breaks: false
});

export async function getDocs(): Promise<Array<DocMeta & { slug: string }>> {
  const entries = await fs.readdir(docsDirectory);
  const docs = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        const slug = entry.replace(/\.md$/, "");
        const source = await fs.readFile(path.join(docsDirectory, entry), "utf8");
        const { data } = matter(source);
        return {
          slug,
          title: String(data.title ?? slug),
          description: String(data.description ?? ""),
          section: String(data.section ?? "Guides"),
          order: Number(data.order ?? 999)
        };
      })
  );
  return docs.sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

export async function getDoc(slug: string): Promise<DocPage | undefined> {
  try {
    const source = await fs.readFile(path.join(docsDirectory, `${slug}.md`), "utf8");
    const { content, data } = matter(source);
    return {
      slug,
      title: String(data.title ?? slug),
      description: String(data.description ?? ""),
      section: String(data.section ?? "Guides"),
      order: Number(data.order ?? 999),
      contentHtml: await marked.parse(content)
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function groupDocs(docs: Array<DocMeta & { slug: string }>) {
  const sections = new Map<string, Array<DocMeta & { slug: string }>>();
  for (const doc of docs) {
    const current = sections.get(doc.section) ?? [];
    current.push(doc);
    sections.set(doc.section, current);
  }
  return [...sections.entries()];
}
