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
        string ipfsHash; // points to full task object (JSON)
        uint256 dueAt;
        uint8 priority;
        Status status;
        uint256 createdAt;
    }

    uint256 public nextId;
    mapping(uint256 => Task) public tasks;
    mapping(address => uint256[]) public tasksByOwner;

    event TaskCreated(uint256 indexed id, address indexed owner, string ipfsHash);

    function createTask(
        string calldata ipfsHash,
        uint256 dueAt,
        uint8 priority
    ) external {
        uint256 id = ++nextId;
        tasks[id] = Task(
            id,
            msg.sender,
            ipfsHash,
            dueAt,
            priority,
            Status.Active,
            block.timestamp
        );
        tasksByOwner[msg.sender].push(id);
        emit TaskCreated(id, msg.sender, ipfsHash);
    }

    function completeTask(uint256 id) external {
        Task storage t = tasks[id];
        require(t.owner == msg.sender, "not owner");
        t.status = Status.Completed;
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
