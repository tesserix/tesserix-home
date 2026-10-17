export function questionnaireClientId() {
  try {
    const id =
      sessionStorage.getItem("questionnaire-client") || crypto.randomUUID();
    sessionStorage.setItem("questionnaire-client", id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
