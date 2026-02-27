# System Flow Diagrams (Part 1)

This document defines the 5 major system flows for the PDF Word Insert & Workflow Management System.

## 1. Authentication Flow

```mermaid
flowchart TD
    A[User Visits Website] --> B[Login Page]
    B --> C[Submit Email + Password]
    C --> D[Backend Validate Credentials]
    D --> E[Role Assigned in JWT]
    E --> F{Role}
    F -->|super_admin| G[/admin]
    F -->|admin| H[/admin]
    F -->|user| I[/user]
```

Security requirements:
- Passwords are hashed (`bcrypt`).
- JWT is issued on successful login.
- Role-based middleware protects routes.

## 2. Template Creation Flow (Admin)

```mermaid
flowchart TD
    A[Admin Dashboard] --> B[Upload PDF Template]
    B --> C[Save File to Storage]
    C --> D[Insert Record into pdf_templates]
    D --> E[Redirect to Field Editor]
```

Result:
- Template is ready for field mapping.

## 3. Field Mapping Flow

```mermaid
flowchart TD
    A[Open Template Editor] --> B[Display PDF Preview]
    B --> C[Admin Clicks Position]
    C --> D[Capture Page + X + Y]
    D --> E[Set Field Name + Required + Font Size]
    E --> F[Save into pdf_fields]
    F --> G{More fields?}
    G -->|Yes| C
    G -->|No| H[Mapping Complete]
```

## 4. PDF Generation Flow (User)

```mermaid
flowchart TD
    A[User Selects Template] --> B[Load Fields from DB]
    B --> C[Render Dynamic Form]
    C --> D[User Fills Form]
    D --> E[Submit]
    E --> F[Backend Loads Original Template PDF]
    F --> G[Loop Through Fields]
    G --> H[Insert Data at X,Y]
    H --> I[Save New PDF File]
    I --> J[Insert Record into generated_pdfs]
    J --> K[Status = pending]
    K --> L[Auto Download + Save to History]
    L --> M[Visible in Template Pending Tab]
```

## 5. Workflow Status Management Flow

```mermaid
flowchart TD
    A[Admin Opens Template] --> B[Click Pending Tab]
    B --> C[Select Generated PDF]
    C --> D{Choose Action}
    D -->|Mark Done| E[Update status = done]
    E --> F[Insert status_history]
    F --> G[Move to Done Tab]
    D -->|Cancel| H[Open Modal: Optional Reason]
    H --> I[Update status = cancelled]
    I --> J[Save status_note]
    J --> K[Insert status_history]
    K --> L[Move to Cancelled Tab]
    D -->|Reschedule| M[Open Modal: Optional Note + Date]
    M --> N[Update status = rescheduled]
    N --> O[Save note + reschedule_date]
    O --> P[Insert status_history]
    P --> Q[Move to Rescheduled Tab]
```

Isolation rule per template:
- `WHERE template_id = ? AND status = ?`
- No cross-template record mixing.
