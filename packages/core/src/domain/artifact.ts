import { z } from "zod";

// 成果物の種類
export const ArtifactType = z.enum([
  "pr", // Pull Request
  "commit", // コミット
  "ci_result", // CI実行結果
  "branch", // ブランチ
  "base_repo_diff", // ローカルベースリポジトリの差分
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

// 成果物スキーマ
export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  type: ArtifactType,
  ref: z.string().nullable(), // PR番号、コミットSHA、ブランチ名など
  url: z.string().url().nullable(),
  metadata: z.record(z.unknown()).nullable(), // 追加情報
  createdAt: z.date(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// 成果物作成時の入力スキーマ
export const CreateArtifactInput = ArtifactSchema.omit({
  id: true,
  createdAt: true,
});
export type CreateArtifactInput = z.infer<typeof CreateArtifactInput>;
