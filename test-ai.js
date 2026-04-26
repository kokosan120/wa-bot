const { GoogleGenerativeAI } = require('@google/generative-ai');

// Dhyan rahe, single quotes '' ke andar hi key paste karni hai
const genAI = new GoogleGenerativeAI('AIzaSyASWmugiQ0y6Ybzxp4n3rhMaroaa_-5BpA');

async function testAI() {
    try {
        console.log("Nayi API Key check kar raha hoon...");
        
        // Sabse latest aur fast model
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const result = await model.generateContent("Hi, reply with just 'Yes, I am working!'");
        console.log("✅ SUCCESS! AI ka reply aaya:", result.response.text());
        
    } catch (error) {
        console.error("❌ ERROR AAYA:", error.message);
    }
}

testAI();
