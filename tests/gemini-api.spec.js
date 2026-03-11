const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

async function testGeminiApi() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("Please set the GEMINI_API_KEY environment variable.");
        process.exit(1);
    }

    const model = 'gemini-2.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const prompt = "Write a short story about a brave knight.";

    const body = {
        contents: [{
            parts: [{
                text: prompt
            }]
        }]
    };

    try {
        console.log(`Sending request to Gemini API with model ${model}...`);
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`API request failed with status ${response.status}:`);
            console.error(data);
            return;
        }

        console.log("API request successful!");
        console.log("Response:");
        console.log(JSON.stringify(data, null, 2));

        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) {
            console.log("\\nSuccessfully extracted text from response.");
        } else {
            console.error("\\nCould not extract text from the response. Response format might have changed.");
        }

    } catch (error) {
        console.error("An error occurred while testing the Gemini API:", error);
    }
}

testGeminiApi();
