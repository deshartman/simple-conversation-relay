export default function verifyCode(functionArgs: any) {
  console.log("TOOL -> called VerifySend");
  const { code } = functionArgs;

  console.log("[Verify Code] functionArgs object:", functionArgs);

  try {
    // Check if a verification code has been included. If so, check the code, else generate one
    if (code) {
      const message = "Verification code included in event object.";
      console.log(
        "[Verify Code] Verification code included in event object:",
        code
      );
      console.log(message);
      return JSON.stringify({
        message,
      });
    } else {
      const message = "No verification code included in event object.";
      console.log(message);
      return JSON.stringify({
        message,
      });
    }
  } catch (error) {
    return JSON.stringify({
      message: "Code could not be verified",
    });
  }
}
