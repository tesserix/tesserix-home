import "server-only";
import { getCurrentSession, isPlatformOperator } from "@tesserix/platform-auth";
import { checkOperatorCapabilityLive } from "@/lib/auth/operator";
export async function requireQuestionnaireViewer() {
  const session = await getCurrentSession();
  if (!session || !isPlatformOperator(session.email))
    throw new Error("Questionnaire access denied");
  await checkOperatorCapabilityLive(session, "platform");
  return session;
}
