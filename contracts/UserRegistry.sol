// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract UserRegistry {
    struct User {
        address wallet;
        string ipfsProfileHash; // optional profile metadata stored on IPFS
        uint256 createdAt;
    }
    mapping(address => User) public users;
    event UserRegistered(address indexed wallet, string ipfsProfileHash, uint256 ts);

    function registerUser(string calldata ipfsHash) external {
        require(users[msg.sender].wallet == address(0), "exists");
        users[msg.sender] = User(msg.sender, ipfsHash, block.timestamp);
        emit UserRegistered(msg.sender, ipfsHash, block.timestamp);
    }

    function getUser(address wallet) external view returns (User memory) {
        return users[wallet];
    }
}
