import twilio from "twilio";

export default function verifySend(functionArgs: any) {
  console.log("TOOL -> called VerifySend");
  const { from } = functionArgs;
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // console.log("[VerifySend] Event object from:", event.from);

  console.log(`[VerifySend] Sending verification code to: ${from}`);
  // Generate a random 4 digit code for the calling number (event.From)
  let code = Math.floor(1000 + Math.random() * 9000);
  // Send the code using the send-sms function
  console.log(
    `[VerifySend] Sending code: ${code} to: ${from} from: ${process.env.SMS_FROM_NUMBER}`
  );

  client.messages
    .create({
      to: from,
      from: process.env.SMS_FROM_NUMBER,
      body: `Your verification code is: ${code}`,
    })
    .then(() => {
      console.log(`[VerifySend] Verification code sent successfully: ${code}`);
      console.log(
        `[VerifySend] Verification code sent successfully to: ${from}`
      );

      return JSON.stringify({
        message: `Secret verification code is ${code}`,
      });
    })
    .catch((err) => {
      console.log(`An error occurred sending SMS`, err);
      return JSON.stringify({
        message: `An error occurred sending verification code`,
      });
    });
}
