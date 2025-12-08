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
        string title;     // ✅
        string ipfsHash;
        uint256 dueAt;
        uint8 priority;
        Status status;
        uint256 createdAt;
    }

    uint256 public nextId;
    mapping(uint256 => Task) public tasks;
    mapping(address => uint256[]) public tasksByOwner;

    event TaskCreated(uint256 indexed id, address indexed owner, string ipfsHash);
    event TaskStatusChanged(uint256 indexed id, Status newStatus);
    event TaskRescheduled(uint256 indexed id, uint256 newDueAt);

    function createTask(
        string calldata title,      // ✅
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
            createdAt: block.timestamp
        });

        tasksByOwner[msg.sender].push(id);
        emit TaskCreated(id, msg.sender, ipfsHash);
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

    function getTasksByOwner(address user) external view returns (Task[] memory) {
        uint256[] storage ids = tasksByOwner[user];
        Task[] memory out = new Task[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = tasks[ids[i]];
        }
        return out;
    }
}
