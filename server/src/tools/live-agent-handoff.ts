export default function liveAgentHandoff(functionArgs: any) {
  console.log("TOOL -> called liveAgentHandoff");
  const { code } = functionArgs;

  console.log("[Live Agent Handoff] functionArgs object:", functionArgs);

  try {
    const message = "Transfer call to a human";
    console.log(message);
    return JSON.stringify({
      message,
    });
  } catch (error) {
    return JSON.stringify({
      message: "Code could not be verified",
    });
  }
}
