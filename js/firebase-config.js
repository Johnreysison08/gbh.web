// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD5-g1bjXfgd1w9boHbfLX8EMnt6tr9yuM",
  authDomain: "gbhub-25a16.firebaseapp.com",
  projectId: "gbhub-25a16",
  storageBucket: "gbhub-25a16.firebasestorage.app",
  messagingSenderId: "1031854442872",
  appId: "1:1031854442872:web:208bc4663cace89f43608d",
  measurementId: "G-XV7WMV0Q82"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);