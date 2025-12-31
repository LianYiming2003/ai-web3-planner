// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract TaskManager {
    enum Status {
        Active,
        Completed,
        Cancelled
    }

    struct Task {
        uint256 id;
        address owner;
        string title;
        string ipfsHash;
        uint256 dueAt;
        uint8 priority;
        Status status;
        uint256 createdAt;

        // time-block fields
        uint256 lastStart;
        uint256 lastEnd;

        // ✅ Week6: mark meeting
        bool isMeeting;
    }

    struct MeetingRecap {
        uint256 meetingTaskId;
        address creator;
        string recapCid; // directory CID
        uint256 createdAt;
    }

    uint256 public nextId;

    mapping(uint256 => Task) public tasks;
    mapping(address => uint256[]) private tasksByOwner;

    // ✅ Week6: meeting recap storage
    mapping(uint256 => MeetingRecap) public meetingRecaps; // meetingTaskId => recap
    mapping(address => uint256[]) private recapIdsByOwner; // owner => meetingTaskId list

    event TaskCreated(uint256 indexed id, address indexed owner, string ipfsHash, bool isMeeting);
    event TaskStatusChanged(uint256 indexed id, Status newStatus);
    event TaskRescheduled(uint256 indexed id, uint256 newDueAt);

    event ScheduleChanged(
        uint256 indexed id,
        uint256 newStart,
        uint256 newEnd,
        string ipfsChangeHash
    );

    event MeetingRecapStored(
        uint256 indexed meetingTaskId,
        address indexed creator,
        string recapCid,
        uint256 timestamp
    );

    function createTask(
        string calldata title,
        string calldata ipfsHash,
        uint256 dueAt,
        uint8 priority
    ) external {
        uint256 id = ++nextId;

        tasks[id] = Task({
            id: id,
            owner: msg.sender,
            title: title,
            ipfsHash: ipfsHash,
            dueAt: dueAt,
            priority: priority,
            status: Status.Active,
            createdAt: block.timestamp,
            lastStart: 0,
            lastEnd: 0,
            isMeeting: false
        });

        tasksByOwner[msg.sender].push(id);
        emit TaskCreated(id, msg.sender, ipfsHash, false);
    }

    // ✅ Week6: create meeting (store start/end into lastStart/lastEnd, dueAt=end)
    function createMeeting(
        string calldata title,
        string calldata ipfsHash,
        uint256 startAt,
        uint256 endAt,
        uint8 priority
    ) external {
        require(endAt >= startAt, "end < start");

        uint256 id = ++nextId;

        tasks[id] = Task({
            id: id,
            owner: msg.sender,
            title: title,
            ipfsHash: ipfsHash,
            dueAt: endAt,
            priority: priority,
            status: Status.Active,
            createdAt: block.timestamp,
            lastStart: startAt,
            lastEnd: endAt,
            isMeeting: true
        });

        tasksByOwner[msg.sender].push(id);
        emit TaskCreated(id, msg.sender, ipfsHash, true);
    }

    function completeTask(uint256 id) external {
        Task storage t = tasks[id];
        require(t.owner == msg.sender, "not owner");
        t.status = Status.Completed;
        emit TaskStatusChanged(id, Status.Completed);
    }

    function setStatus(uint256 id, Status newStatus) external {
        Task storage t = tasks[id];
        require(t.owner == msg.sender, "not owner");
        t.status = newStatus;
        emit TaskStatusChanged(id, newStatus);
    }

    function rescheduleTask(uint256 id, uint256 newDueAt) external {
        Task storage t = tasks[id];
        require(t.owner == msg.sender, "not owner");
        t.dueAt = newDueAt;
        emit TaskRescheduled(id, newDueAt);
    }

    function logScheduleChange(
        uint256 id,
        uint256 newStart,
        uint256 newEnd,
        string calldata ipfsHash
    ) external {
        Task storage t = tasks[id];
        require(t.owner == msg.sender, "not owner");

        t.lastStart = newStart;
        t.lastEnd = newEnd;

        emit ScheduleChanged(id, newStart, newEnd, ipfsHash);
    }

    // ✅ Week6: store recap CID for a meeting
    function storeMeetingRecap(uint256 meetingTaskId, string calldata recapCid) external {
        Task storage t = tasks[meetingTaskId];
        require(t.owner == msg.sender, "not owner");
        require(t.isMeeting, "not meeting");

        meetingRecaps[meetingTaskId] = MeetingRecap({
            meetingTaskId: meetingTaskId,
            creator: msg.sender,
            recapCid: recapCid,
            createdAt: block.timestamp
        });

        recapIdsByOwner[msg.sender].push(meetingTaskId);
        emit MeetingRecapStored(meetingTaskId, msg.sender, recapCid, block.timestamp);
    }

    function getTasksByOwner(address user) external view returns (Task[] memory) {
        uint256[] storage ids = tasksByOwner[user];
        Task[] memory out = new Task[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = tasks[ids[i]];
        }
        return out;
    }

    function getMeetingRecapsByOwner(address user) external view returns (MeetingRecap[] memory) {
        uint256[] storage ids = recapIdsByOwner[user];
        MeetingRecap[] memory out = new MeetingRecap[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = meetingRecaps[ids[i]];
        }
        return out;
    }
}