const functions = require("firebase-functions");
const axios = require("axios");

// Load the key from Firebase environment variables
const GEMINI_API_KEY = functions.config().gemini.key;

// Cloud Function: generate a tongue twister using Gemini
exports.generateTwister = functions.https.onCall(async (data, context) => {
  const { level, category } = data;
  
  // NOTE: You don't need the category in the prompt since the client side
  // only sends 'level' (as 'difficulty'). I'm simplifying the prompt.

  const prompt = `Generate a short, fun, and highly alliterative English tongue twister suitable for a user at the ${level} difficulty level.`;

  try {
    const response = await axios.post(
      // FIX: Use the correct, clean URL without the 'key=YOUR_KEY' placeholder
      "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent",
      {
        // Use the correct Gemini API structure
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ]
      },
      {
        // FIX: Correctly pass the API key using 'params' for the URL query string
        params: { key: GEMINI_API_KEY }
      }
    );

    // FIX: Access the content property correctly
    const text =
      response.data.candidates?.[0]?.content?.parts?.[0]?.text || "No twister generated.";

    return { twister: text };
  } catch (error) {
    console.error("Gemini error:", error.response?.data || error.message);
    return { twister: "Error generating twister." };
  }
});