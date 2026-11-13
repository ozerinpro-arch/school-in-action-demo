"""All names, records and amounts below were invented for the demo."""


def seed_state() -> dict:
    teachers = [
        {"id": "t1", "name": "Maya Brooks", "subject": "Biology"},
        {"id": "t2", "name": "Owen Reed", "subject": "Biology", "requiredRoom": "Lab 2"},
        {"id": "t3", "name": "Nora Finch", "subject": "Biology"},
        {"id": "t4", "name": "Alex Vale", "subject": "Mathematics"},
    ]
    students = [
        {"id": "s1", "name": "Jamie Lane", "className": "Grade 7A"},
        {"id": "s2", "name": "Riley Bell", "className": "Grade 7B"},
    ]
    records = [
        ("l1", "Monday", "09:00", "09:45", "Grade 7A", "t1", "Lab 1", "Cell structure"),
        ("l2", "Monday", "09:00", "09:45", "Grade 7B", "t3", "Lab 3", "Plant cells"),
        ("l3", "Tuesday", "10:00", "10:45", "Grade 7A", "t4", "Room 12", "Ratios"),
        ("l4", "Wednesday", "09:00", "09:45", "Grade 7A", "t1", "Lab 1", "Food webs"),
        ("l5", "Wednesday", "10:00", "10:45", "Grade 7B", "t2", "Lab 2", "Habitats"),
        ("l6", "Friday", "11:00", "11:45", "Grade 7A", "t1", "Lab 1", "Ecosystems"),
    ]
    by_id = {teacher["id"]: teacher for teacher in teachers}
    lessons = [
        {"id": identity, "day": day, "start": start, "end": end, "className": group,
         "teacherId": teacher, "teacherName": by_id[teacher]["name"],
         "subject": by_id[teacher]["subject"], "room": room, "topic": topic, "status": "normal"}
        for identity, day, start, end, group, teacher, room, topic in records
    ]
    return {
        "schedule": lessons, "teachers": teachers, "students": students, "replacements": [],
        "assignments": [
            {"id": "a1", "title": "Draw a plant cell", "instructions": "Label three parts and explain what each does.",
             "studentId": "s1", "teacherId": "t1", "subject": "Biology", "dueDate": "2026-11-20",
             "status": "open", "answer": "", "score": None, "feedback": ""},
        ],
        "materials": [
            {"id": "m1", "title": "Cell structure lab notes", "content": "Compare the nucleus, cell membrane and cell wall. Sketch what you see under the microscope.",
             "lessonId": "l1", "teacherId": "t1"},
        ],
        "tasks": [
            {"id": "k1", "title": "Check microscope slides", "description": "Prepare a labelled tray for Grade 7A.",
             "status": "open", "ownerId": "t1", "owner": "Maya Brooks"},
        ],
        "documents": [
            {"id": "doc1", "title": "Lab safety checklist", "content": "Review the goggles, clean benches and equipment sign-out before the lab.",
             "status": "in review"},
        ],
        "activity": [],
        "clubs": {
            "programs": [
                {"id": "c1", "name": "Robotics club", "description": "Build and program a tabletop rover.",
                 "meetingTime": "Wednesday, 15:30", "capacity": 8, "feeCents": 1250, "archived": False},
                {"id": "c2", "name": "Sketchbook club", "description": "Practice observation drawing and share work.",
                 "meetingTime": "Friday, 15:00", "capacity": 6, "feeCents": 0, "archived": False},
            ],
            "enrollments": [], "charges": [],
        },
    }
