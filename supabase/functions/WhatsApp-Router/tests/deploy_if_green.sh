#!/bin/zsh
# ينشر WhatsApp-Router فقط لو كل اختبارات الانحدار ناجحة (٤ نوفمبر ٢٠٢٦: انتشرت v487 مع اختبار فاشل
# لأن أمر النشر ما توقّف على الفشل). الاستعمال من repo/:  zsh supabase/functions/WhatsApp-Router/tests/deploy_if_green.sh
cd "$(dirname "$0")/../../../.." || exit 1
out=$(NO_COLOR=1 npx -y deno@2.5.6 run -A supabase/functions/WhatsApp-Router/tests/intake_replay.ts 2>&1)
code=$?
print -r -- "$out" | grep -E "^❌|✗|النتيجة"
if [ $code -ne 0 ] || print -r -- "$out" | grep -q "^❌"; then
  print "🛑 فيه اختبار فاشل — ما نشرت."
  exit 1
fi
supabase functions deploy WhatsApp-Router --no-verify-jwt --project-ref ofotvacszlmrqxzfjmtn 2>&1 | grep -E "Deployed|rror"
