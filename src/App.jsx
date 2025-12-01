import React, { useState, useCallback, useEffect, useRef } from 'react';
import { RefreshCcw, Mic, Volume2, Lightbulb, Zap, XCircle } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, setLogLevel } from 'firebase/firestore'; 

// --- CONFIGURATION AND UTILITIES ---

// Global Canvas-provided variables (must be used)
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Correctly parse VITE_FIREBASE_CONFIG for non-Canvas environments
const firebaseConfig = import.meta.env.VITE_FIREBASE_CONFIG ? 
    JSON.parse(import.meta.env.VITE_FIREBASE_CONFIG) : 
    (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null);
    
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// API Key (loaded from .env)
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY; 

// Use the latest, stable model ID for all v1 API calls
const FLASH_MODEL = "gemini-2.5-flash"; 

const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// Polyfill for base64ToArrayBuffer (Required for PCM audio processing - kept for completeness)
const base64ToArrayBuffer = (base64) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(0);
    }
    return bytes.buffer;
};


// --- API CALL HANDLERS ---

/**
 * Calls browser's native Web Speech API for reliable audio playback (TTS Fallback).
 * Note: Keeping this simple to avoid the issues with Google Cloud TTS API setup.
 */
const speakText = async (text, speed = 1.0) => {
    try {
        if (!('speechSynthesis' in window)) {
            console.error("Browser does not support Web Speech API.");
            return false;
        }
        
        // Stop any current speech
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = speed; // Use the speed from state
        
        utterance.onerror = (event) => {
            console.error('Speech Synthesis Error:', event.error);
        };

        window.speechSynthesis.speak(utterance);
        
        return true;
    } catch (err) {
        console.error("TTS Error:", err);
        return false;
    }
};

/**
 * Calls Gemini to generate a tongue twister based on difficulty.
 * Uses the final, working combined USER role payload structure.
 */
const generateTwister = async (difficulty) => {
    const systemInstruction = `
        You are an expert language pattern generator.
        Return ONLY a JSON object with:
        - "twisterText": the tongue twister (8–12 words)
        - "difficulty": the same difficulty the user selected
        Do not include any other text or markdown formatting (e.g., no \`\`\`json).
    `;

    // Final Working Fix: Combine system and user prompts into a single user message
    const combinedQuery = `
        ${systemInstruction}
        
        Now, based on this instruction, here is the request:
        Generate a tongue twister suitable for an English learner 
        at the ${difficulty} difficulty level.
        It must be short, fun, and alliterative.
    `;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: combinedQuery }]
            }
        ],
        generationConfig: {} 
    };

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${FLASH_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        const errorResult = await response.json(); 
        console.error("Twister API Failed. Full response:", errorResult);
        throw new Error("API error " + response.status + ": Check console for details.");
    }


    const result = await response.json();

    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonString) {
         console.error("No text output from Gemini:", result);
         return null;
    }

    // Handle markdown wrapper that models sometimes include
    try {
        const cleanedJson = jsonString.replace(/```json\s*|```/g, '').trim();
        return JSON.parse(cleanedJson);
    } catch (e) {
        console.error("Failed to parse JSON string:", jsonString, e);
        return null;
    }
};

/**
 * Calls Gemini to rate the user's speech recording against the target text.
 * Includes the STRICT system prompt to enforce 0/10 for silent/bad audio.
 */
const ratePronunciation = async (targetText, base64Audio, mimeType) => {

    // FIX: New, STRICT system prompt
    const systemPrompt = `
        You are an extremely strict English pronunciation validator.
        
        Your task is to compare the user's spoken audio with the target text.
        
        **CRITICAL RULE: If the audio is silent, garbled, or contains speech that is NOT the target text, you MUST return this exact JSON:**
        
        {"score": 0, "feedback": "ERROR: No valid or relevant speech was detected in the recording. Please ensure you are speaking the target text clearly.", "mispronouncedWords": []}
        
        If the audio is valid and relevant, then return ONLY a JSON object formatted as follows, with a score from 1 to 10:
        {"score": [integer 1-10], "feedback": "[short paragraph of helpful feedback]", "mispronouncedWords": [array of words the user mispronounced]}
        
        Do not include any other text or markdown formatting (e.g., no \`\`\`json).
    `;

    // Final Working Fix: Combine system prompt with the target text instruction
    const combinedTextPrompt = `
        ${systemPrompt}
        
        Now, analyze the following audio. The target tongue twister text is: "${targetText}".
        The audio file to be analyzed is attached below.
    `;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [
                    // Text part now contains the combined system and target prompt
                    { text: combinedTextPrompt }, 
                    // Audio part
                    {
                        inlineData: {
                            mimeType: mimeType, 
                            data: base64Audio
                        }
                    }
                ]
            }
        ],
        generationConfig: {}
    };

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${FLASH_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        const errorResult = await response.json(); 
        console.error("Rating API Failed. Full response:", errorResult);
        throw new Error("API error " + response.status + ": Check console for details.");
    }

    const result = await response.json();

    const jsonString = result.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!jsonString) {
        return {
            score: 0,
            feedback: "Error processing audio. Model returned no response.",
            mispronouncedWords: []
        };
    }

    // Handle markdown wrapper that models sometimes include
    try {
        const cleanedJson = jsonString.replace(/```json\s*|```/g, '').trim();
        return JSON.parse(cleanedJson);
    } catch (e) {
        console.error("Failed to parse JSON string:", jsonString, e);
        // Catch parsing errors and treat as an API failure
        return {
            score: 0,
            feedback: "Error: Model returned an unparseable response.",
            mispronouncedWords: []
        };
    }
};

/**
 * Generates a helpful "Pro Tip".
 */
const generateProTip = async (twisterText, mispronouncedWords, difficulty) => {

    const prompt = `
        Based on the tongue twister: "${twisterText}"
        And the user's mispronounced words: [${mispronouncedWords.join(", ")}]

        Give ONE concise pronunciation tip (under 60 words).
        Make it personal, specific, and encouraging.
        Return it as plain text only.
    `;

    const payload = {
        contents: [
            {
                role: "user",
                parts: [{ text: prompt }]
            }
        ]
    };

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1/models/${FLASH_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }
    );

    if (!response.ok) {
        const errorResult = await response.json();
        console.error("ProTip API Failed. Full response:", errorResult);
        // We will ignore this error and use a fallback
        return "Focus on slow, clear repetition to strengthen muscle memory.";
    }

    const result = await response.json();

    return (
        result.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Focus on slow, clear repetition to strengthen muscle memory."
    );
};


// --- REACT COMPONENT ---

const App = () => {
    // Firebase State (Setup for future persistence)
    const [auth, setAuth] = useState(null);
    const [db, setDb] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    // UI State
    const [view, setView] = useState('generate');
    const [difficulty, setDifficulty] = useState('moderate');
    const [speed, setSpeed] = useState(1.0);
    const [errorState, setErrorState] = useState(null); 

    // Twister Content State
    const [twisterText, setTwisterText] = useState('');
    const [customTwisterInput, setCustomTwisterInput] = useState('');

    // Interaction State
    const [isLoading, setIsLoading] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [result, setResult] = useState(null);
    const [proTip, setProTip] = useState('');

    // Audio Recording State
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    // Map speed value to a readable label
    const speedLabels = { 0.5: 'Slow', 1.0: 'Normal', 1.5: 'Fast' };

    // --- EFFECT: Firebase Initialization ---
    useEffect(() => {
        const initializeFirebase = async () => {
            if (!firebaseConfig) {
                console.error("Firebase configuration is missing.");
                setIsAuthReady(true);
                setUserId(crypto.randomUUID()); 
                setErrorState("Warning: Data persistence (score history) will be unavailable without Firebase configuration.");
                return;
            }

            try {
                const app = initializeApp(firebaseConfig);
                const firestore = getFirestore(app);
                const authInstance = getAuth(app);
                setLogLevel('Debug');

                // Authentication
                if (initialAuthToken) {
                    await signInWithCustomToken(authInstance, initialAuthToken);
                } else {
                    await signInAnonymously(authInstance);
                }
                
                const currentUserId = authInstance.currentUser?.uid || crypto.randomUUID();

                setAuth(authInstance);
                setDb(firestore);
                setUserId(currentUserId);
                setIsAuthReady(true);

            } catch (err) {
                console.error("Firebase initialization or authentication failed:", err);
                setUserId(crypto.randomUUID()); 
                setIsAuthReady(true);
                setErrorState("Authentication failed. Score history features will be disabled.");
            }
        };

        initializeFirebase();

    }, []);

    // --- HANDLERS: Generation ---
    const handleGenerateTwister = useCallback(async (newDifficulty = difficulty) => {
        setIsLoading(true);
        setResult(null); 
        setProTip(''); 
        setTwisterText(''); 
        setErrorState(null); 
        
        try {
            const generated = await generateTwister(newDifficulty);
            
            if (generated && generated.twisterText) {
                setTwisterText(generated.twisterText);
            } else {
                setTwisterText("Peter Piper picked a peck of pickled peppers.");
                setErrorState("Could not generate a new twister. Using a default. (Check console for API error details.)");
            }
        } catch (e) {
             console.error("Twister generation failed:", e);
             setTwisterText("Peter Piper picked a peck of pickled peppers.");
             setErrorState("Twister generation failed. Check console for API error details.");
        }
        
        setIsLoading(false);
    }, [difficulty]);


    // --- EFFECT: Initial/Generated Twister ---
    useEffect(() => {
        if (view === 'generate' && !twisterText && !isLoading && isAuthReady) {
            handleGenerateTwister(difficulty);
        }
    }, [view, twisterText, difficulty, handleGenerateTwister, isLoading, isAuthReady]);


    // --- HANDLERS: Speech/TTS ---

    const handleSpeak = async (text, playbackSpeed = speed) => {
        if (isSpeaking || isLoading) return;
        setErrorState(null); 
        
        setIsSpeaking(true);
        const success = await speakText(text, playbackSpeed); 
        if (!success) {
            setErrorState("Failed to play audio. Check browser support.");
        }
        
        // Wait for speech to finish before allowing more interactions
        // Note: Web Speech API doesn't have a reliable promise finish, so we estimate.
        const durationEstimate = 2000 + (text.length * 70 / playbackSpeed);
        setTimeout(() => setIsSpeaking(false), durationEstimate);
    };

    // --- HANDLERS: Recording ---

    const startRecording = async () => {
        if (isLoading || isSpeaking) return;
        setResult(null);
        setProTip(null);
        setErrorState(null); 

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Use generic MediaRecorder to default to the browser's supported format
            mediaRecorderRef.current = new MediaRecorder(stream);
            
            audioChunksRef.current = [];

            mediaRecorderRef.current.ondataavailable = (event) => {
                audioChunksRef.current.push(event.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                stream.getTracks().forEach(track => track.stop());
                
                // Get the Blob. The browser determines the type.
                const audioBlob = new Blob(audioChunksRef.current);

                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = async () => {
                    const base64Audio = reader.result.split(',')[1];
                    // Determine the actual MIME type of the recorded audio
                    const mimeType = audioBlob.type || 'audio/webm'; 
                    const textToRate = twisterText || customTwisterInput;
                    // Pass the MIME type to the rating function
                    await handleRating(textToRate, base64Audio, mimeType); 
                };
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (err) {
            console.error('Error accessing microphone:', err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                 setErrorState("Microphone access denied! Please grant permission in your browser settings to record your Twisty Talk.");
            } else {
                 setErrorState("Could not start recording. Ensure a microphone is connected and working.");
            }
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };
    
    // --- HANDLER: Rating ---
    const handleRating = async (text, base64Audio, mimeType) => {
        setIsLoading(true);
        setErrorState(null); 
        let ratingResult = null;
        
        try {
            // Pass mimeType to ratePronunciation
            ratingResult = await ratePronunciation(text, base64Audio, mimeType);
            setResult(ratingResult);

            if (ratingResult && ratingResult.score !== undefined) {
                if (ratingResult.mispronouncedWords.length > 0) {
                    const tip = await generateProTip(text, ratingResult.mispronouncedWords, difficulty);
                    setProTip(tip);
                } else if (ratingResult.score === 0) {
                     // Specifically handle the 0/10 error feedback from the strict prompt
                     setProTip(null); 
                } else {
                     setProTip("Terrific job! You smashed that tongue twister! Practice that speed!");
                }
            } else {
                setErrorState("Speech analysis failed to return a valid result. Try recording again. (Check console for API error details.)");
            }
        } catch (e) {
            console.error("Speech rating failed:", e);
            setErrorState("Speech analysis failed. Check console for API error details.");
            setResult(null);
        }

        setIsLoading(false);
    };


    // --- RENDERING COMPONENTS ---

    const DifficultySelector = () => (
        <div className="flex flex-wrap justify-center gap-4 mb-8">
            {['easy', 'moderate', 'difficult'].map((d) => (
                <button
                    key={d}
                    onClick={() => {
                        setDifficulty(d);
                        handleGenerateTwister(d);
                    }}
                    disabled={isLoading || isRecording || isSpeaking || !isAuthReady}
                    className={`px-6 py-3 text-base font-extrabold uppercase tracking-wide rounded-full transition-all duration-300 shadow-xl transform hover:scale-105 active:scale-95 border-2 ${
                        difficulty === d
                            ? 'bg-gradient-to-r from-lime-400 to-cyan-500 text-zinc-900 border-lime-300 shadow-lime-500/50'
                            : 'bg-zinc-700 text-zinc-200 border-zinc-600 hover:bg-zinc-600'
                    }`}
                >
                    {d}
                </button>
            ))}
            <button
                onClick={() => handleGenerateTwister(difficulty)}
                disabled={isLoading || isRecording || isSpeaking || !isAuthReady}
                className="px-6 py-3 text-base font-extrabold uppercase tracking-wide rounded-full transition-all duration-300 bg-zinc-700 text-zinc-200 border-2 border-zinc-600 hover:bg-zinc-600 shadow-xl flex items-center space-x-2 transform hover:scale-105 active:scale-95"
                title="Generate a new twister"
            >
                <RefreshCcw className="w-5 h-5" /> <span>New Twister</span>
            </button>
        </div>
    );

    const SpeedSelector = () => (
        <div className="flex flex-wrap justify-center gap-4 items-center bg-zinc-800/70 p-4 rounded-xl shadow-inner border border-zinc-700">
            <label className="text-zinc-300 font-bold text-lg whitespace-nowrap">AI Read Speed:</label>
            {[0.5, 1.0, 1.5].map((s) => (
                <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    disabled={isLoading || isRecording || isSpeaking}
                    className={`px-5 py-2 text-sm font-medium rounded-full transition-all duration-200 ${
                        speed === s
                            ? 'bg-purple-600 text-white shadow-lg ring-2 ring-purple-400'
                            : 'bg-zinc-600 text-zinc-200 hover:bg-purple-500'
                    }`}
                >
                    {s}x ({speedLabels[s]})
                </button>
            ))}
            <button
                onClick={() => handleSpeak(twisterText || customTwisterInput, speed)}
                disabled={isLoading || isSpeaking || (!twisterText && view === 'generate') || (!customTwisterInput && view === 'custom')}
                className="px-5 py-2 text-sm font-medium rounded-full transition-all bg-lime-500 text-zinc-900 hover:bg-lime-400 shadow-lg flex items-center space-x-2"
                title="Hear the system read the text"
            >
                <Volume2 className="w-5 h-5" />
                <span>Hear It!</span>
            </button>
        </div>
    );

    const MainCard = () => (
        <div className="bg-zinc-900/90 p-8 sm:p-10 rounded-3xl shadow-4xl shadow-purple-950/70 w-full max-w-3xl mx-auto transition-all duration-700 border-4 border-purple-700/50 backdrop-blur-sm">
            <div className="flex justify-between items-center mb-8 border-b-2 border-zinc-800 pb-6">
                <h2 className="text-3xl font-extrabold text-zinc-100 uppercase tracking-wider">
                    {view === 'generate' ? 'Your Challenge' : 'Custom Entry'}
                </h2>
                <button
                    onClick={() => {
                        setView(view === 'generate' ? 'custom' : 'generate');
                        setResult(null);
                        setProTip('');
                        setErrorState(null);
                        setTwisterText(view === 'generate' ? customTwisterInput : ''); 
                    }}
                    disabled={isLoading || isRecording || isSpeaking || !isAuthReady}
                    className="text-lg font-medium text-lime-400 hover:text-lime-200 transition-colors flex items-center space-x-2"
                >
                    <Zap className="w-5 h-5" />
                    <span>{view === 'generate' ? 'Create Your Own' : 'New Random'}</span>
                </button>
            </div>

            {view === 'generate' && <DifficultySelector />}

            <div className="min-h-[160px] mb-10 p-6 bg-gradient-to-br from-zinc-800/80 to-zinc-900/80 border-l-8 border-lime-400 rounded-xl flex items-center justify-center shadow-inner-lg">
                {view === 'generate' && (
                    <p className={`text-center text-3xl sm:text-4xl font-extrabold leading-snug tracking-tight ${isLoading ? 'text-zinc-500 animate-pulse' : 'text-zinc-100'}`}>
                        {isLoading ? 'Spinning up a challenge...' : twisterText || 'Select a difficulty or click "New Twister" to begin the fun!'}
                    </p>
                )}
                {view === 'custom' && (
                    <textarea
                        key="custom-input"
                        value={customTwisterInput}
                        // FIX: Corrected onChange handler to fix the one-letter input bug by ensuring state is updated cleanly
                        onChange={(e) => {
                            const newValue = e.target.value;
                            setCustomTwisterInput(newValue); // Primary state update must happen first and correctly
                            
                            // Secondary updates can follow
                            setTwisterText(newValue); 
                            setResult(null);
                            setProTip('');
                            setErrorState(null);
                        }}
                        placeholder="Type your hilarious twister here!"
                        disabled={isLoading || isRecording || isSpeaking || !isAuthReady}
                        className="w-full h-32 p-3 text-center text-2xl sm:text-3xl border-none bg-transparent resize-none focus:ring-0 font-extrabold leading-snug text-zinc-100 placeholder-zinc-500"
                    />
                )}
            </div>

            <div className="flex flex-col items-center space-y-8">
                <SpeedSelector />

                <button
                    onClick={isRecording ? stopRecording : startRecording}
                    disabled={isLoading || isSpeaking || !isAuthReady || (view === 'generate' && !twisterText) || (view === 'custom' && !customTwisterInput)}
                    className={`w-full py-5 rounded-full font-black text-xl sm:text-2xl transition-all duration-300 shadow-3xl flex items-center justify-center space-x-4 uppercase tracking-widest border-2 border-transparent
                        ${isRecording
                            ? 'bg-gradient-to-r from-red-500 to-rose-600 text-white animate-pulse ring-4 ring-red-400/50'
                            : 'bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700 shadow-pink-500/50'
                        }
                        ${isLoading || isSpeaking || !isAuthReady ? 'opacity-60 cursor-not-allowed' : 'hover:scale-[1.02] active:scale-[0.98]'}
                    `}
                >
                    {isRecording ? (
                        <>
                            <Mic className="w-7 h-7 animate-bounce" />
                            <span>Stop & Judge My Talk!</span>
                        </>
                    ) : (
                        <>
                            <Mic className="w-7 h-7" />
                            <span>Unleash the Twisty Talk!</span>
                        </>
                    )}
                </button>
            </div>
        </div>
    );

    const ResultDisplay = () => {
        if (isLoading) {
            return (
                <div className="flex flex-col items-center justify-center p-10 mt-10 bg-zinc-900/90 rounded-3xl shadow-3xl shadow-purple-950/70 w-full max-w-3xl mx-auto border-4 border-purple-700/50 animate-fade-in">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-lime-500"></div>
                    <p className="ml-3 mt-6 text-lime-400 text-xl font-bold">The AI Judge is listening intently...</p>
                </div>
            );
        }

        if (result && result.score !== undefined) {
            const scoreColor = result.score >= 8 ? 'text-lime-400' : result.score >= 5 ? 'text-yellow-400' : 'text-pink-400';
            const scoreBg = result.score >= 8 ? 'bg-lime-900/30' : result.score >= 5 ? 'bg-yellow-900/30' : 'bg-pink-900/30';

            const mispronouncedWords = Array.isArray(result.mispronouncedWords) ? result.mispronouncedWords : [];

            return (
                <div className="bg-zinc-900/90 p-8 rounded-3xl shadow-3xl shadow-purple-950/70 mt-10 w-full max-w-3xl mx-auto border-4 border-purple-700/50 animate-fade-in backdrop-blur-sm">
                    <h2 className="text-3xl font-black text-zinc-100 mb-6 flex items-center justify-between uppercase tracking-wider">
                        The Verdict
                        <div className={`p-4 rounded-2xl font-extrabold text-4xl ${scoreColor} ${scoreBg} shadow-inner`}>
                            {result.score}/10
                        </div>
                    </h2>
                    
                    {mispronouncedWords.length > 0 && (
                        <div className="mb-8 p-5 bg-pink-900/30 rounded-xl border border-pink-700 shadow-lg">
                            <h3 className="font-extrabold text-pink-400 text-xl flex items-center mb-4 uppercase">
                                <XCircle className="w-6 h-6 mr-3 text-pink-500" />
                                Your Tongue Got Twisted Here:
                            </h3>
                            <div className="flex flex-wrap gap-3">
                                {mispronouncedWords.map((word, index) => (
                                    <span 
                                        key={index}
                                        className="px-5 py-2 bg-pink-700 text-pink-100 text-base font-medium rounded-full shadow-lg border border-pink-500 transform hover:scale-105 transition-transform"
                                    >
                                        {word}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="text-zinc-300 space-y-5 mb-8">
                        <h3 className="font-extrabold text-xl border-b border-zinc-800 pb-3 flex items-center uppercase">
                            Coach's Corner:
                        </h3>
                        <p className="whitespace-pre-wrap leading-relaxed text-zinc-200 text-lg">{result.feedback}</p>
                    </div>

                    {proTip && (
                        <div className="mt-8 p-5 bg-cyan-900/30 rounded-xl border border-cyan-700 shadow-lg">
                            <h3 className="font-extrabold text-cyan-400 text-xl flex items-center mb-4 uppercase">
                                <Lightbulb className="w-6 h-6 mr-3 text-cyan-500" />
                                Game-Winning Pro Tip:
                            </h3>
                            <p className="text-cyan-200 leading-relaxed text-lg">{proTip}</p>
                        </div>
                    )}
                </div>
            );
        }

        return null;
    };


    return (
        <div className="min-h-screen bg-gradient-to-br from-zinc-950 to-gray-900 p-6 sm:p-10 flex flex-col items-center font-sans text-zinc-100 relative overflow-hidden">
            {/* Dynamic Background Effect */}
            <style>{`
                .bg-pattern {
                    background-image: radial-gradient(circle at center, rgba(147, 51, 234, 0.1), transparent 50%), 
                                      linear-gradient(135deg, rgba(6, 182, 212, 0.1), rgba(16, 185, 129, 0.1));
                    background-size: 500% 500%;
                    animation: pan-bg 60s linear infinite;
                }
                @keyframes pan-bg {
                    0% { background-position: 0% 0%; }
                    50% { background-position: 100% 100%; }
                    100% { background-position: 0% 0%; }
                }
            `}</style>
            <div className="absolute inset-0 z-0 opacity-8 bg-pattern"></div>

            <header className="text-center mb-12 mt-8 z-10">
                <h1 className="text-6xl sm:text-7xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-lime-300 to-cyan-500 tracking-tight leading-tight drop-shadow-3xl shadow-lime-500/50 uppercase">
                    TwistyTalk
                </h1>
                <p className="text-2xl text-zinc-400 mt-4 max-w-xl mx-auto font-light">
                    It's time to train your mouth muscles! Try not to trip!
                </p>
                {/* REMOVED: {userId && <p className="text-sm text-zinc-500 mt-2">User ID: {userId}</p>} */}
            </header>

            {errorState && (
                <div className="mt-6 p-4 bg-red-900/40 border border-red-700 rounded-xl w-full max-w-3xl mx-auto text-red-300 font-medium z-10 animate-fade-in shadow-xl mb-8">
                    <h3 className="font-bold flex items-center mb-2">
                        <XCircle className="w-5 h-5 mr-2" />
                        Error Alert!
                    </h3>
                    <p>{errorState}</p>
                </div>
            )}

            <MainCard />
            <ResultDisplay />

            <footer className="mt-20 text-md text-zinc-600 z-10">
                {/* FIX: Updated year from 2024 to 2025 */}
                <p>&copy; 2025 TwistyTalk. Powered by Gemini AI.</p>
            </footer>
        </div>
    );
};

export default App;