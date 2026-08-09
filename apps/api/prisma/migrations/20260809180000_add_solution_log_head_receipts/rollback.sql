DROP TRIGGER IF EXISTS solution_log_head_receipts_no_truncate ON public.solution_log_head_receipts;
DROP TRIGGER IF EXISTS solution_log_head_receipts_append_only ON public.solution_log_head_receipts;
DROP FUNCTION IF EXISTS public.solution_log_head_receipts_guard();
DROP TABLE IF EXISTS public.solution_log_head_receipts;
