export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <main className="flex flex-col items-center justify-center p-8">
        <h1 className="text-3xl font-bold mb-4">Glenn Backend API</h1>
        <p className="text-lg text-gray-600">Backend service is running</p>
        <p className="text-sm text-gray-500 mt-2">API Endpoints:</p>
        <ul className="text-sm text-gray-500 mt-2">
          <li>POST /api/participate - Tournament participation</li>
        </ul>
      </main>
    </div>
  );
}
