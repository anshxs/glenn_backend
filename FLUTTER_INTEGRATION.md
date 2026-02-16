# Flutter App Configuration Guide

## CORS Configuration for Flutter Apps

### 🎯 Do You Need CORS?

**Short Answer**: Only if you're building for Flutter Web.

| Platform | CORS Needed? | Why? |
|----------|--------------|------|
| **iOS** | ❌ No | Native apps bypass browser CORS |
| **Android** | ❌ No | Native apps bypass browser CORS |
| **Web** | ✅ Yes | Browsers enforce CORS policy |
| **Desktop** | ❌ No | Native apps bypass browser CORS |

---

## For Flutter Mobile Apps (iOS/Android) - RECOMMENDED

### Your Setup is Already Perfect! ✅

Flutter mobile apps make direct HTTP requests without browser restrictions.

**Your Flutter Code**:
```dart
import 'package:http/http.dart' as http;
import 'dart:convert';

Future<void> participateInTournament() async {
  final accessToken = // Get from Supabase auth
  
  final response = await http.post(
    Uri.parse('http://localhost:3000/api/participate'), // Dev
    // Uri.parse('https://your-backend.com/api/participate'), // Production
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer $accessToken',
    },
    body: jsonEncode({
      'amount': 100,
      'user_id': userId,
      'tournament_id': tournamentId,
      'participant_id': userId,
      'team_members': {},
      'team_name': null,
    }),
  );

  if (response.statusCode == 200) {
    final data = jsonDecode(response.body);
    print('Success: ${data['message']}');
  } else {
    final error = jsonDecode(response.body);
    print('Error: ${error['message']}');
  }
}
```

**No CORS configuration needed!** ✅

---

## For Flutter Web Apps

### Backend Setup (Next.js)

If you want to support Flutter Web, the `middleware.ts` file has been created with CORS headers.

**Update the allowed origins**:

```typescript
// middleware.ts
const allowedOrigins = [
  'http://localhost:3000',  // Local Flutter Web dev
  'https://your-app.web.app',  // Your Flutter Web domain
];
```

### Flutter Web Code (Same as Mobile)

```dart
// Works for both mobile and web
final response = await http.post(
  Uri.parse('https://your-backend.com/api/participate'),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $accessToken',
  },
  body: jsonEncode(payload),
);
```

---

## Development vs Production URLs

### During Development

**Backend**: `http://localhost:3000`

```dart
// Flutter app
final apiUrl = 'http://localhost:3000/api/participate';
```

**Android Emulator Note**: Use `http://10.0.2.2:3000` instead of `localhost`
```dart
final apiUrl = Platform.isAndroid 
  ? 'http://10.0.2.2:3000/api/participate'  // Android emulator
  : 'http://localhost:3000/api/participate'; // iOS simulator
```

### In Production

**Backend**: `https://your-domain.com` (Vercel, etc.)

```dart
// Use environment variables
const apiUrl = String.fromEnvironment(
  'API_URL',
  defaultValue: 'http://localhost:3000',
);

final response = await http.post(
  Uri.parse('$apiUrl/api/participate'),
  // ...
);
```

Build with:
```bash
# Development
flutter run

# Production
flutter build apk --dart-define=API_URL=https://your-backend.com
flutter build ios --dart-define=API_URL=https://your-backend.com
```

---

## Complete Flutter Example

### 1. Install Dependencies

```yaml
# pubspec.yaml
dependencies:
  http: ^1.1.0
  supabase_flutter: ^2.0.0
  flutter_secure_storage: ^9.0.0
```

### 2. Initialize Supabase

```dart
// main.dart
import 'package:supabase_flutter/supabase_flutter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  await Supabase.initialize(
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key',
  );
  
  runApp(MyApp());
}

final supabase = Supabase.instance.client;
```

### 3. Tournament Participation Service

```dart
// services/tournament_service.dart
import 'package:http/http.dart' as http;
import 'dart:convert';
import 'package:supabase_flutter/supabase_flutter.dart';

class TournamentService {
  final String baseUrl;
  
  TournamentService({
    this.baseUrl = 'http://localhost:3000', // Change for production
  });
  
  Future<Map<String, dynamic>> participateInTournament({
    required double amount,
    required String tournamentId,
    Map<String, dynamic>? teamMembers,
    String? teamName,
  }) async {
    try {
      // Get current user and token
      final session = Supabase.instance.client.auth.currentSession;
      if (session == null) {
        throw Exception('User not authenticated');
      }
      
      final userId = session.user.id;
      final accessToken = session.accessToken;
      
      // Make API request
      final response = await http.post(
        Uri.parse('$baseUrl/api/participate'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $accessToken',
        },
        body: jsonEncode({
          'amount': amount,
          'user_id': userId,
          'tournament_id': tournamentId,
          'participant_id': userId,
          'team_members': teamMembers ?? {},
          'team_name': teamName,
        }),
      );
      
      final data = jsonDecode(response.body);
      
      if (response.statusCode == 200) {
        return {
          'success': true,
          'data': data['data'],
          'message': data['message'],
        };
      } else {
        return {
          'success': false,
          'error': data['error'],
          'message': data['message'],
        };
      }
    } catch (e) {
      return {
        'success': false,
        'error': 'Network Error',
        'message': e.toString(),
      };
    }
  }
}
```

### 4. Usage in Widget

```dart
// screens/tournament_screen.dart
class TournamentScreen extends StatelessWidget {
  final tournamentService = TournamentService();
  
  Future<void> joinTournament() async {
    final result = await tournamentService.participateInTournament(
      amount: 100.0,
      tournamentId: 'tournament-uuid-here',
      teamMembers: {
        'member1': {
          'name': 'Player 2',
          'ffuid': '123456',
        }
      },
      teamName: 'My Squad',
    );
    
    if (result['success']) {
      print('Registered! New balance: ${result['data']['new_wallet_balance']}');
      // Show success message
    } else {
      print('Error: ${result['message']}');
      // Show error message
      if (result['error'] == 'Insufficient balance') {
        // Show add funds dialog
      }
    }
  }
  
  @override
  Widget build(BuildContext context) {
    return ElevatedButton(
      onPressed: joinTournament,
      child: Text('Join Tournament'),
    );
  }
}
```

---

## Error Handling

```dart
Future<void> participateWithErrorHandling() async {
  try {
    final result = await tournamentService.participateInTournament(
      amount: 100.0,
      tournamentId: tournamentId,
    );
    
    if (!result['success']) {
      switch (result['error']) {
        case 'Insufficient balance':
          // Show add funds screen
          showAddFundsDialog();
          break;
        case 'Insufficient slots':
          // Show tournament full message
          showTournamentFullDialog();
          break;
        case 'Already registered':
          // Show already registered message
          showAlreadyRegisteredDialog();
          break;
        case 'Too many requests':
          // Show rate limit message
          showRateLimitDialog();
          break;
        default:
          // Generic error
          showErrorDialog(result['message']);
      }
    }
  } on SocketException {
    showErrorDialog('No internet connection');
  } on TimeoutException {
    showErrorDialog('Request timeout. Please try again.');
  } catch (e) {
    showErrorDialog('An unexpected error occurred');
  }
}
```

---

## Authentication Flow

```dart
// 1. User signs in with Supabase
final response = await Supabase.instance.client.auth.signInWithPassword(
  email: 'user@example.com',
  password: 'password',
);

// 2. Token is automatically available
final accessToken = Supabase.instance.client.auth.currentSession?.accessToken;

// 3. Use token in API requests
headers: {
  'Authorization': 'Bearer $accessToken',
}

// 4. Auto-refresh (Supabase handles this)
// Token auto-refreshes before expiration
```

---

## Summary

### For Your Flutter Mobile App (iOS/Android):

✅ **No CORS configuration needed**  
✅ **No `middleware.ts` needed**  
✅ **Just make HTTP requests directly**  
✅ **Current backend setup is perfect**  

### Key Points:

1. **Delete `middleware.ts`** if you're only doing mobile
2. **No origin restrictions** for native apps
3. **Just use the API URL** with Bearer token
4. **Supabase handles token refresh** automatically
5. **Use `http://10.0.2.2:3000`** for Android emulator

Your backend is ready to receive requests from your Flutter mobile app! 🚀
