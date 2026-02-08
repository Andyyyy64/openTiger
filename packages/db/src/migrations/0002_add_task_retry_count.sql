-- 失敗タスクのリトライ回数を記録するカラムを追加
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;
