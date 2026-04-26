// Niche wali line mein apni ASLI API Key daalo
const API_KEY = 'AIzaSyASWmugiQ0y6Ybzxp4n3rhMaroaa_-5BpA'; 

async function checkModels() {
    try {
        console.log("Google se aapke available models ki list nikal raha hoon...\n");
        
        // Google ke server se direct models ki list maang raha hai
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();
        
        if (data.error) {
            console.error("❌ API Key Error:", data.error.message);
            return;
        }

        console.log("✅ Aapki API Key in models ko support karti hai:\n");
        
        // Sabhi models ke naam print karega
        data.models.forEach(model => {
            // Hum sirf generateContent wale models filter kar rahe hain
            if(model.supportedGenerationMethods.includes("generateContent")) {
                console.log(`👉 ${model.name.replace('models/', '')}`);
            }
        });
        
        console.log("\nUpar di gayi list mein se jo model aaye, uska naam mujhe batao!");
    } catch (error) {
        console.error("❌ Network Error:", error);
    }
}

checkModels();
