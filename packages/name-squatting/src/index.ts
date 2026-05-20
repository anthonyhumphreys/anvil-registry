export type PopularPackage = {
  name: string;
  weeklyDownloads?: number;
};

export type NameSquattingSignal = {
  candidate: string;
  similarity: number;
  distance: number;
  weeklyDownloads?: number;
  reasons: string[];
};

export const defaultPopularPackages: PopularPackage[] = [
  { name: "lodash", weeklyDownloads: 60_000_000 },
  { name: "react", weeklyDownloads: 30_000_000 },
  { name: "@tanstack/react-query", weeklyDownloads: 4_000_000 },
  { name: "@vitejs/plugin-react", weeklyDownloads: 5_000_000 },
  { name: "vite", weeklyDownloads: 20_000_000 },
  { name: "typescript", weeklyDownloads: 50_000_000 },
  { name: "express", weeklyDownloads: 25_000_000 },
  { name: "fastify", weeklyDownloads: 3_000_000 }
];

export function splitPackageName(packageName: string): { scope?: string; name: string } {
  if (!packageName.startsWith("@")) return { name: packageName };
  const [scope, name] = packageName.split("/");
  return { scope, name: name ?? "" };
}

export function normaliseName(packageName: string): string {
  const { scope, name } = splitPackageName(packageName.toLowerCase());
  return `${scope ?? ""}/${name}`.replace(/[@/_-]/g, "");
}

export function damerauLevenshtein(a: string, b: string): number {
  const da = new Map<string, number>();
  const maxDistance = a.length + b.length;
  const matrix: number[][] = Array.from({ length: a.length + 2 }, () => Array<number>(b.length + 2).fill(0));

  matrix[0]![0] = maxDistance;
  for (let i = 0; i <= a.length; i += 1) {
    matrix[i + 1]![0] = maxDistance;
    matrix[i + 1]![1] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0]![j + 1] = maxDistance;
    matrix[1]![j + 1] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    let db = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const i1 = da.get(b[j - 1]!) ?? 0;
      const j1 = db;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      }
      matrix[i + 1]![j + 1] = Math.min(
        matrix[i]![j]! + cost,
        matrix[i + 1]![j]! + 1,
        matrix[i]![j + 1]! + 1,
        matrix[i1]![j1]! + (i - i1 - 1) + 1 + (j - j1 - 1)
      );
    }
    da.set(a[i - 1]!, i);
  }

  return matrix[a.length + 1]![b.length + 1]!;
}

export function similarity(a: string, b: string): number {
  const left = normaliseName(a);
  const right = normaliseName(b);
  const maxLength = Math.max(left.length, right.length, 1);
  return 1 - damerauLevenshtein(left, right) / maxLength;
}

export function detectNameSquatting(
  packageName: string,
  popularPackages: PopularPackage[] = defaultPopularPackages
): NameSquattingSignal[] {
  const requested = splitPackageName(packageName);

  return popularPackages
    .filter((candidate) => candidate.name !== packageName)
    .map((candidate) => {
      const candidateParts = splitPackageName(candidate.name);
      const score = similarity(packageName, candidate.name);
      const distance = damerauLevenshtein(normaliseName(packageName), normaliseName(candidate.name));
      const reasons: string[] = [];

      if (score >= 0.82) reasons.push("high_name_similarity");
      if (requested.name.replace(/[-_]/g, "") === candidateParts.name.replace(/[-_]/g, "")) {
        reasons.push("hyphen_or_underscore_variant");
      }
      if (requested.scope && candidateParts.scope && similarity(requested.scope, candidateParts.scope) >= 0.75) {
        reasons.push("similar_scope");
      }
      if (distance <= 2) reasons.push("short_edit_distance");

      return {
        candidate: candidate.name,
        similarity: Number(score.toFixed(3)),
        distance,
        weeklyDownloads: candidate.weeklyDownloads,
        reasons
      };
    })
    .filter((signal) => signal.reasons.length > 0)
    .sort((a, b) => b.similarity - a.similarity);
}
